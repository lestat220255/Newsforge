#!/usr/bin/env python3
"""Newsforge 全站 QA 检查（后端）。
用法: python3 pipeline/qa-check.py [--date YYYY-MM-DD]
检查项: 配置 / edition 结构 / 字数 / 不变式 / 图片对应 / 跨期 / JSON 文件 / 脚本语法 / detailDate 链式 / URL 闭合
退出码: 0=全过, 1=有失败
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
EDITIONS = os.path.join(DATA, 'editions')
PUBLIC_IMG = os.path.join(ROOT, 'public', 'images')

passed, failed = [], []

def ok(name):
    passed.append(name)

def fail(name, detail=''):
    failed.append(f'{name}: {detail}')

def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)

# ---------- 1. 脚本语法 ----------
for script in ['pipeline/run.js', 'pipeline/site-config.js', 'pipeline/probe-sources.js',
               'pipeline/fetch-text.js', 'pipeline/topics.js',
               'pipeline/lib/utils.js', 'pipeline/lib/fetchers.js', 'pipeline/lib/edit.js',
               'pipeline/lib/images.js', 'pipeline/lib/render.js', 'pipeline/lib/r2-images.js']:
    r = subprocess.run(['node', '--check', script], cwd=ROOT, capture_output=True)
    if r.returncode == 0:
        ok(f'语法 {script}')
    else:
        fail(f'语法 {script}', r.stderr.decode()[:200])

# ---------- 2. site-config.js 可加载、≥1 个模块 ----------
r = subprocess.run(['node', '-e',
    "import('./pipeline/site-config.js').then(m=>{console.log(JSON.stringify({n:m.SECTIONS.length,ids:m.SECTIONS.map(s=>s.id),tz:m.SITE.timezone}))})"],
    cwd=ROOT, capture_output=True, text=True)
try:
    cfg = json.loads(r.stdout.strip().splitlines()[-1])
    if cfg['n'] >= 1:
        ok(f"site-config {cfg['n']} 个模块")
    else:
        fail('site-config 模块数', 'modules/ 下没有可用的 module.json')
    if cfg.get('tz'):
        ok(f"site-config 时区 {cfg['tz']}")
    else:
        fail('site-config 时区', 'SITE.timezone 缺失')
    # 每个 source 有 name/type（全下划线开头的 key 是教学注释条目，跳过）
    r2 = subprocess.run(['node', '-e',
        "import('./pipeline/site-config.js').then(m=>{const bad=[];for(const s of m.SECTIONS)for(const src of s.sources||[]){if(Object.keys(src).every(k=>k.startsWith('_')))continue;if(!src.name||!src.type)bad.push(s.id)}console.log(JSON.stringify(bad))})"],
        cwd=ROOT, capture_output=True, text=True)
    bad = json.loads(r2.stdout.strip().splitlines()[-1])
    if not bad:
        ok('config sources 字段完整')
    else:
        fail('config sources 字段完整', str(bad))
except Exception as e:
    fail('config 加载', str(e)[:150])

# ---------- 2b. 图片体积预算（b64 进 git 的膨胀刹车，不依赖 edition，放前面） ----------
# 90 天清理把工作区稳定在 ~160MB；超过 250MB 说明清理没跑或图片过大，挡住推送人工看一眼
# R2 模式本地无 b64（或仅有未上传的临时文件），此项自然通过
IMG_BUDGET = 250 * 1024 * 1024
img_total, img_n = 0, 0
if os.path.isdir(PUBLIC_IMG):
    for fn in os.listdir(PUBLIC_IMG):
        if fn.endswith('.b64'):
            img_n += 1
            img_total += os.path.getsize(os.path.join(PUBLIC_IMG, fn))
if img_total > IMG_BUDGET:
    fail('图片体积预算', f'public/images 下 {img_n} 个 b64 共 {img_total/1048576:.0f}MB，超 250MB 预算：检查 pruneOldFiles 是否运行，或迁到 R2（见 docs/R2-IMAGES.md）')
else:
    ok(f'图片体积预算（{img_n} 个 b64，共 {img_total/1024:.0f}KB）')

# ---------- 3. 最新 edition 结构与字数 ----------
dates = sorted(f[:10] for f in os.listdir(EDITIONS) if re.match(r'\d{4}-\d{2}-\d{2}\.json$', f)) if os.path.isdir(EDITIONS) else []
if not dates:
    # 新站首次构建前 data/editions 为空：内容检查无从谈起，优雅跳过（不是失败）
    ok('无 edition 数据，跳过内容检查（新站首次构建前正常）')
    date = None
    ed = None
else:
    date = sys.argv[sys.argv.index('--date') + 1] if '--date' in sys.argv else dates[-1]
    ed = load_json(os.path.join(EDITIONS, f'{date}.json'))

if ed is None:
    # 新模板首次运行：只做了上面的配置与语法检查，直接出报告
    print('\n===== QA 后端检查（无 edition，内容检查已跳过） =====')
    print(f'通过 {len(passed)} / 失败 {len(failed)}')
    for f in failed:
        print('  FAIL:', f)
    sys.exit(1 if failed else 0)

HL_REQ = ['title', 'summary', 'comment', 'analysis', 'url', 'publishedAt', 'source']
IT_REQ = ['title', 'blurb', 'summary', 'analysis', 'url', 'publishedAt', 'source']
for sec in ed['sections']:
    sid = sec['id']
    if sec.get('hidden'):
        if sec.get('headline') or sec.get('items'):
            fail(f'{sid} hidden 板块仍有内容', '')
        else:
            ok(f'{sid} hidden 为空')
        continue
    h = sec.get('headline') or {}
    for k in HL_REQ:
        if not h.get(k):
            fail(f'{sid} 头条缺字段 {k}', '')
    if len(h.get('summary', '')) > 200:
        fail(f'{sid} 头条摘要超 200 字', str(len(h.get('summary', ''))))
    if len(h.get('analysis', '')) > 500:
        fail(f'{sid} 头条分析超 500 字', str(len(h.get('analysis', ''))))
    if not str(h.get('url', '')).startswith('http'):
        fail(f'{sid} 头条 url 非法', h.get('url', '')[:50])
    # 不变式
    for it in sec.get('items', []):
        for k in IT_REQ:
            if not it.get(k):
                fail(f'{sid} 次条缺字段 {k}', it.get('title', '')[:20])
        if len(it.get('blurb', '')) > 20:
            fail(f'{sid} 次条 blurb 超 20 字', it.get('title', '')[:20])
        if len(it.get('summary', '')) > 200:
            fail(f'{sid} 次条摘要超 200 字', it.get('title', '')[:20])
        if it.get('unverified'):
            if it.get('hot'):
                fail(f'{sid} 待确认条目带 hot', it.get('title', '')[:20])
            if it.get('multi_source'):
                fail(f'{sid} 待确认条目 multi_source=true', it.get('title', '')[:20])
    if h.get('unverified') and h.get('hot'):
        fail(f'{sid} 头条待确认却带 hot', '')
    if len(sec.get('items', [])) <= 5:
        ok(f'{sid} 次条 ≤5')
    else:
        fail(f'{sid} 次条超 5', str(len(sec.get('items', []))))
    # 25. keyFacts（2026-10-08）：有则 3-6 条、每条 ≤30 字
    for entry, label in [(h, '头条')] + [(it, f'次条{i}') for i, it in enumerate(sec.get('items', []))]:
        kf = entry.get('keyFacts')
        if kf is None:
            continue
        if not isinstance(kf, list) or not (3 <= len(kf) <= 6):
            fail(f'{sid} {label} keyFacts 条数非法', f'{label}:{entry.get("title","")[:20]} n={len(kf) if isinstance(kf, list) else "?"}')
            continue
        for f in kf:
            if len(str(f)) > 30:
                fail(f'{sid} {label} keyFacts 超 30 字', str(f)[:34])
                break
        else:
            ok(f'{sid} {label} keyFacts 合规')
ok(f'{date} 结构与字数检查完成')

# 26. dailyDigest（2026-10-09 起）：topPicks 只指向 hot 头条、≤配置条数；oneLiner ≤40 字
dd = ed.get('dailyDigest')
if dd is not None:
    max_picks = 3
    try:
        site_cfg = json.load(open('site.json'))
        tp = site_cfg.get('features', {}).get('topPicks', {})
        if isinstance(tp, dict) and tp.get('count'):
            max_picks = min(max(int(tp['count']), 1), 5)
    except Exception:
        pass
    picks = dd.get('topPicks', [])
    if not isinstance(picks, list) or len(picks) > max_picks:
        fail(f'{date} dailyDigest topPicks 超 {max_picks} 条', str(len(picks) if isinstance(picks, list) else '?'))
    else:
        sec_by_id = {s['id']: s for s in ed['sections']}
        bad = []
        for p in picks:
            sec = sec_by_id.get(p.get('section')) or {}
            h = sec.get('headline') or {}
            if p.get('index') != 0 or not h.get('hot') or sec.get('hidden'):
                bad.append(str(p.get('section')))
        if bad:
            fail(f'{date} dailyDigest topPicks 非 hot 头条', ','.join(bad))
        else:
            ok(f'{date} dailyDigest topPicks 合规')
    if len(str(dd.get('oneLiner', ''))) > 40:
        fail(f'{date} dailyDigest oneLiner 超 40 字', str(dd.get('oneLiner'))[:44])
    else:
        ok(f'{date} dailyDigest oneLiner 合规')

# ---------- 4. 图片对应（按图判断，b64/R2 混存的过渡期也能处理） ----------
# https 绝对 URL（R2）：必须在 data/image-dims.json 边车有记录（= 已上传；推送前另做逐个 curl 实测）
# 本地 /images/ 路径（b64）：必须有对应的本地 .b64 文件
missing = []
dims = {}
try:
    dims = load_json(os.path.join(DATA, 'image-dims.json'))
except Exception:
    pass
for sec in ed['sections']:
    imgs = []
    h = sec.get('headline') or {}
    if h.get('image'):
        imgs.append(h['image'])
    for it in sec.get('items', []):
        if it.get('hot') and it.get('image'):
            imgs.append(it['image'])
    for im in imgs:
        if isinstance(im, str) and im.startswith('https://'):
            if im not in dims:
                missing.append(im + '（边车无记录）')
        else:
            p = os.path.join(ROOT, 'public' + im + '.b64')
            if not os.path.exists(p):
                missing.append(im)
if not missing:
    ok('图片一一对应')
else:
    fail('图片一一对应', '; '.join(missing[:5]))

# ---------- 5. 沿用 ≤1 天 ----------
for sec_id in [s['id'] for s in ed['sections']]:
    streak = 0
    for d in reversed(dates):
        e = load_json(os.path.join(EDITIONS, f'{d}.json'))
        s = next((x for x in e['sections'] if x['id'] == sec_id), None)
        if s and s.get('carried'):
            streak += 1
        else:
            break
    if streak > 1:
        fail('沿用连续≤1天', f'{sec_id} 连续 {streak} 天')
ok('沿用连续≤1天')

# ---------- 6. 详情页 URL 跨期去重（同 URL 必须同标题；沿用复用原 URL 是设计） ----------
seen = {}
dups = []
for d in dates:
    e = load_json(os.path.join(EDITIONS, f'{d}.json'))
    for s in e['sections']:
        for idx, entry in enumerate([s.get('headline')] + list(s.get('items', []))):
            if not entry:
                continue
            url = f"/detail/{s.get('detailDate', d)}/{s['id']}-{idx}/"
            title = entry.get('title', '')
            if url in seen and seen[url] != title:
                dups.append(f'{url} 标题冲突: {seen[url][:15]} vs {title[:15]}')
            seen[url] = title
if not dups:
    ok('详情页 URL 跨期无标题冲突')
else:
    fail('详情页 URL 跨期无标题冲突', '; '.join(dups[:5]))

# ---------- 7. 数据文件（首次运行前不存在属正常） ----------
for f in ['source-health.json', 'corrections.json']:
    p = os.path.join(DATA, f)
    if not os.path.exists(p):
        ok(f'data/{f} 不存在（首次运行前正常）')
        continue
    try:
        load_json(p)
        ok(f'data/{f} 合法 JSON')
    except Exception as e:
        fail(f'data/{f} 合法 JSON', str(e)[:100])
p = os.path.join(DATA, 'disabled-sources.json')
if os.path.exists(p):
    try:
        load_json(p)
        ok('data/disabled-sources.json 合法')
    except Exception as e:
        fail('data/disabled-sources.json 合法', str(e)[:100])
else:
    ok('data/disabled-sources.json 不存在（无禁用源）')

# ---------- 8. detailDate 链式与 URL 闭合性（2026-10-08）----------
eds = {}
for d in dates:
    eds[d] = load_json(os.path.join(EDITIONS, f'{d}.json'))

def sec_of(ed, sid):
    for s in ed.get('sections', []):
        if s.get('id') == sid:
            return s
    return None

# 23. detailDate 无链式：指向的目标期数该板块必须是生成点（detailDate 缺失或自指）
chained = []
for d in dates:
    for s in eds[d].get('sections', []):
        dd = s.get('detailDate')
        if not dd or dd == d:
            continue
        if dd not in eds:
            chained.append(f'{d}/{s["id"]}: detailDate={dd} 期数不存在')
            continue
        ts = sec_of(eds[dd], s['id'])
        tdd = (ts.get('detailDate') if ts else None) or dd
        if not ts:
            chained.append(f'{d}/{s["id"]}: detailDate={dd} 目标期数无此板块')
        elif tdd != dd:
            chained.append(f'{d}/{s["id"]}: detailDate={dd} 链式（目标仍指向 {tdd}）')
if not chained:
    ok('detailDate 无链式指向')
else:
    fail('detailDate 无链式指向', '; '.join(chained[:5]))

# 24. detail URL 闭合性：所有被引用（首页/归档/话题）的详情 URL 必须实际生成
generated, referenced = set(), set()
for d in dates:
    for s in eds[d].get('sections', []):
        if s.get('empty'):
            continue
        dd = s.get('detailDate') or d
        n = (1 if s.get('headline') else 0) + len(s.get('items', []))
        for i in range(n):
            u = f'/detail/{dd}/{s["id"]}-{i}/'
            referenced.add(u)
            if dd == d:
                generated.add(u)
missing = referenced - generated
if not missing:
    ok('detail URL 引用闭合（无死链）')
else:
    fail('detail URL 引用闭合（无死链）', '; '.join(sorted(missing)[:8]))

# ---------- 报告 ----------
print(f'\n===== QA 后端检查 {date} =====')
print(f'通过 {len(passed)} / 失败 {len(failed)}')
for f in failed:
    print('  FAIL:', f)
sys.exit(1 if failed else 0)
