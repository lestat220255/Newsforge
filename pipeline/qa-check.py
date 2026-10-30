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

passed, failed, warned = [], [], []

def ok(name):
    passed.append(name)

def fail(name, detail=''):
    failed.append(f'{name}: {detail}')

def warn(name, detail=''):
    # 只警告不硬拦：复核提醒，不是定罪；不影响退出码
    warned.append(f'{name}: {detail}')

def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)

# ---------- 1. 脚本语法 ----------
for script in ['pipeline/run.js', 'pipeline/site-config.js', 'pipeline/probe-sources.js',
               'pipeline/fetch-text.js', 'pipeline/topics.js',
               'pipeline/lib/utils.js', 'pipeline/lib/fetchers.js', 'pipeline/lib/edit.js',
               'pipeline/lib/images.js', 'pipeline/lib/render.js', 'pipeline/lib/r2-images.js',
               'pipeline/qa-render-order.js']:
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

# 新规则生效口径（site.json → quality.evidenceSince）：新检查（evidence/回应/三段式/publisher/300 字上限）
# 只约束生效日期起的新生成；未配置时对所有期数生效（新站默认）；沿用板块恒豁免（旧内容原样复用）。
# 语言口径同 site.json → site.language（未配置时读 site.json.example，默认 zh-CN）。
def _site_conf():
    for p in [os.path.join(ROOT, 'site.json'), os.path.join(ROOT, 'site.json.example')]:
        try:
            return load_json(p)
        except Exception:
            continue
    return {}
_SITE_CONF = _site_conf()
SITE_LANG = str(_SITE_CONF.get('site', {}).get('language') or 'zh-CN')
EVIDENCE_SINCE = _SITE_CONF.get('quality', {}).get('evidenceSince')
if not (isinstance(EVIDENCE_SINCE, str) and EVIDENCE_SINCE):
    EVIDENCE_SINCE = None
NEW_RULES = EVIDENCE_SINCE is None or date >= EVIDENCE_SINCE
INFERENCE_MARKER = 'AI 推断：' if SITE_LANG.startswith('zh') else 'AI inference: '
for sec in ed['sections']:
    sid = sec['id']
    # 板块名必填（2026-10-18 空白事故：edition 漏写 name 会导致导航/标题/面板全空白上线；QA 直接拦截）
    if not sec.get('name'):
        fail(f'{sid} 板块缺 name', '')
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
    # 新分析规则：头条分析总长 ≤300 字；沿用板块是旧内容原样复用（或未到生效日期），沿用旧 500 字上限，否则每次沿用都会误报
    _acap = 500 if sec.get('carried') or not NEW_RULES else 300
    if len(h.get('analysis', '')) > _acap:
        fail(f'{sid} 头条分析超 {_acap} 字', str(len(h.get('analysis', ''))))
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
    # 25. keyFacts：有则 3-6 条；新格式 {tag, content} 与旧字符串并存
    # 可见字数 = 去掉 ** 与反引号后的长度（➔ 按 1 字计）；tag 不合规只警告不硬拦
    # tag 规则按语言配置：zh-CN 示例为 2–4 个 CJK 字符、禁标点；其他语言为 1–20 字、不含标点
    def _visible(text):
        return re.sub(r'[*`]+', '', str(text))
    def _tag_warn(tag):
        if tag is None or tag == '':
            return '缺 tag'
        if SITE_LANG.startswith('zh'):
            if not (2 <= len(tag) <= 4 and all('\u4e00' <= c <= '\u9fff' for c in tag)):
                return 'tag 不合规'
        else:
            if not (1 <= len(tag) <= 20 and not re.search(r'[.,;:!?、。！？；：]', tag)):
                return 'tag 不合规'
        return None
    for entry, label in [(h, '头条')] + [(it, f'次条{i}') for i, it in enumerate(sec.get('items', []))]:
        kf = entry.get('keyFacts')
        if kf is None:
            continue
        if not isinstance(kf, list) or not (3 <= len(kf) <= 6):
            fail(f'{sid} {label} keyFacts 条数非法', f'{label}:{entry.get("title","")[:20]} n={len(kf) if isinstance(kf, list) else "?"}')
            continue
        bad_name, bad_detail = None, ''
        for f in kf:
            if isinstance(f, dict):
                content = f.get('content')
                if not isinstance(content, str) or not content:
                    bad_name, bad_detail = f'{label} keyFacts content 缺失/非法', entry.get('title', '')[:20]
                    break
                if len(_visible(content)) > 30:
                    bad_name, bad_detail = f'{label} keyFacts 超 30 字', content[:34]
                    break
                tw = _tag_warn(f.get('tag'))
                if tw:
                    warn(f'{sid} {label} keyFacts {tw}', entry.get('title', '')[:20])
            elif isinstance(f, str):
                if len(f) > 30:
                    bad_name, bad_detail = f'{label} keyFacts 超 30 字', f[:34]
                    break
            else:
                bad_name, bad_detail = f'{label} keyFacts 元素类型非法', entry.get('title', '')[:20]
                break
        if bad_name:
            fail(f'{sid} {bad_name}', bad_detail)
        else:
            ok(f'{sid} {label} keyFacts 合规')
ok(f'{date} 结构与字数检查完成')

# ---------- 27. 详情页质量规则（evidence/回应/自我引用/三段式/publisher/低信息）：只约束生效日期起的新生成 ----------
# 生效口径见 NEW_RULES（quality.evidenceSince，未配置则对所有期数生效）；沿用/隐藏板块恒豁免（旧内容原样复用）
if NEW_RULES:
    # 全站详情 URL 集合（供自我引用解析校验；口径同第 6 项）
    valid_urls = set()
    for d in dates:
        e_all = load_json(os.path.join(EDITIONS, f'{d}.json'))
        for s_all in e_all['sections']:
            dd_all = s_all.get('detailDate') or d
            for idx_all, entry_all in enumerate([s_all.get('headline')] + list(s_all.get('items', []))):
                if entry_all:
                    valid_urls.add(f"/detail/{dd_all}/{s_all['id']}-{idx_all}/")
    for sec in ed['sections']:
        if sec.get('hidden') or sec.get('carried'):
            continue
        sid = sec['id']
        for entry, label in [(sec.get('headline') or {}, '头条')] + [(it, f'次条{i}') for i, it in enumerate(sec.get('items', []))]:
            if not entry:
                continue
            title = entry.get('title', '')[:20]
            # 当事方回应三态必填；responded 须有回应内容
            pr = entry.get('partyResponse')
            if not isinstance(pr, dict) or pr.get('status') not in ('responded', 'declined', 'not_mentioned'):
                fail(f'{sid} {label} partyResponse 缺失/非法', title)
            elif pr.get('status') == 'responded' and not (isinstance(pr.get('text'), str) and pr.get('text').strip()):
                fail(f'{sid} {label} partyResponse responded 缺回应内容', title)
            else:
                ok(f'{sid} {label} partyResponse 合规')
            # keyFacts evidence：dict 事实行须带 evidence；标签不得在值里重复；有效行 < 3 条不许写 keyFacts
            kf = entry.get('keyFacts')
            if isinstance(kf, list) and kf:
                bad = None
                valid_n = 0
                for f in kf:
                    if isinstance(f, dict):
                        if not (isinstance(f.get('evidence'), str) and f.get('evidence').strip()):
                            bad = f'{label} keyFacts 缺 evidence'
                            break
                        if f.get('tag') and f.get('tag') in (f.get('content') or ''):
                            bad = f'{label} keyFacts 标签与值重复'
                            break
                        valid_n += 1
                    elif isinstance(f, str):
                        valid_n += 1
                if bad:
                    fail(f'{sid} {bad}', title)
                elif valid_n < 3:
                    fail(f'{sid} {label} keyFacts 有效行不足 3 条', title)
                else:
                    ok(f'{sid} {label} keyFacts evidence 合规')
            # 自我引用：分析里每处“本站…报道”须带可解析的详情链接；所有 /detail/ 链接须指向已存在、早于本期的条目
            analysis = entry.get('analysis') or ''
            urls = re.findall(r'/detail/\d{4}-\d{2}-\d{2}/[\w-]+-\d+/', analysis)
            if SITE_LANG.startswith('zh'):
                mentions = re.findall(r'本站[^，。；\n]{0,30}报道', analysis)
                if mentions:
                    if len(urls) < len(mentions):
                        fail(f'{sid} {label} 自我引用缺详情链接', title)
                    else:
                        bad_url = [u for u in urls if u not in valid_urls or u.split('/')[2] >= date]
                        if bad_url:
                            fail(f'{sid} {label} 自我引用链接无法解析或非往期', f'{title} {bad_url[0]}')
                        else:
                            ok(f'{sid} {label} 自我引用可解析')
            if not SITE_LANG.startswith('zh') or not re.findall(r'本站[^，。；\n]{0,30}报道', analysis):
                bad_url = [u for u in urls if u not in valid_urls or u.split('/')[2] >= date]
                if bad_url:
                    fail(f'{sid} {label} 自我引用链接无法解析或非往期', f'{title} {bad_url[0]}')
                elif urls and not SITE_LANG.startswith('zh'):
                    ok(f'{sid} {label} 自我引用可解析')
            # 分析三段式（事实/分析/对读者的意义）+ 分析小节须含 AI 推断标注
            paras = [p.strip() for p in (entry.get('analysis') or '').split('\n\n') if p.strip()]
            if len(paras) != 3:
                fail(f'{sid} {label} 分析非三段式', title)
            elif INFERENCE_MARKER not in paras[1]:
                fail(f'{sid} {label} 分析小节缺 AI 推断标注', title)
            else:
                ok(f'{sid} {label} 分析三段式合规')
            if label != '头条' and len(entry.get('analysis') or '') > 300:
                fail(f'{sid} {label} 分析超 300 字', title)
            # 语言一致性（只警告，仅 CJK 站）：去掉 AI 推断标记与 /detail/ 引用链接后，仍含 4 字母以上英文词
            if SITE_LANG.startswith('zh'):
                _clean = re.sub(r'/detail/\d{4}-\d{2}-\d{2}/[\w-]+-\d+/', '', re.sub(r'AI 推断', '', entry.get('analysis') or ''))
                if re.search(r'[A-Za-z]{4,}', _clean):
                    warn(f'{sid} {label} 分析含英文词', title)
            # publisher 必填（discovered_via 仅适用时写，不硬拦）
            if not (isinstance(entry.get('publisher'), str) and entry.get('publisher').strip()):
                fail(f'{sid} {label} publisher 缺失', title)
            else:
                ok(f'{sid} {label} publisher 合规')
            # 低信息嫌疑（只警告）：摘要 + 分析 ≥2 处“原文未提”
            if ((entry.get('summary') or '') + (entry.get('analysis') or '')).count('原文未提') >= 2:
                warn(f'{sid} {label} 低信息嫌疑（≥2 处原文未提）', title)

# ---------- 28. 标题强断言词筛查（只警告不硬拦，供编辑人工复核） ----------
# 词表按语言配置：zh-CN 为示例；英文用词界匹配（避免 issues 命中 sues 这类子串误报）；未配置的语言跳过本项
ASSERTION_PATTERNS = {
    'zh-CN': [(w, w) for w in ['起诉', '驳斥', '否认', '证实', '违反', '首例', '首次']] + [(r'第\d+次', '第N次')],
    'en': [(r'\b' + w + r'\b', w) for w in ['sues', 'sued', 'denies', 'denied', 'confirms', 'confirmed', 'violates', 'violated', 'first-ever']],
}
_lang_key = SITE_LANG if SITE_LANG in ASSERTION_PATTERNS else ('zh-CN' if SITE_LANG.startswith('zh') else None)
if _lang_key:
    _flags = re.I if _lang_key == 'en' else 0
    for sec in ed['sections']:
        if sec.get('hidden'):
            continue
        sid = sec['id']
        for entry in [sec.get('headline')] + list(sec.get('items', [])):
            if not entry:
                continue
            t = entry.get('title', '')
            hit = [name for pat, name in ASSERTION_PATTERNS[_lang_key] if re.search(pat, t, _flags)]
            if hit:
                warn(f'{sid} 标题含强断言词', f"{','.join(hit)} | {t[:30]}")

# 26. dailyDigest（2026-10-09 起）：topPicks 只指向 hot 头条、≤配置条数（oneLiner 已于 2026-10-17 随 A 合并移除，不再校验）
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
# 顺序口径（QA-6 修复，2026-10-30）：详情页 URL 序号以渲染为准，即 loadEdition 重排后位置
# （未证实沉底、发布时间倒序），不是文件原顺序。此处直接调渲染的 loadEdition（经
# pipeline/qa-render-order.js），不在 Python 里复刻排序规则，避免两份规则漂移。
# 顺序表拿不到时硬拦本项，绝不静默回落到文件顺序（回落等于把 bug 原样放行）。
seen = {}
dups = []
order_ok = True
try:
    r = subprocess.run(['node', 'pipeline/qa-render-order.js'],
                       cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip().splitlines()[-1][:200] if r.stderr.strip() else 'node helper 非零退出')
    render_order = json.loads(r.stdout.strip().splitlines()[-1])
except Exception as e:
    fail('详情页 URL 跨期无标题冲突', f'渲染顺序表获取失败：{str(e)[:150]}')
    order_ok = False
if order_ok:
    for d in dates:
        e = load_json(os.path.join(EDITIONS, f'{d}.json'))
        for s in e['sections']:
            titles = (render_order.get(d) or {}).get(s['id'])
            if titles is None:
                fail('详情页 URL 跨期无标题冲突', f'{d}/{s["id"]} 缺渲染顺序表')
                order_ok = False
                break
            for idx, title in enumerate(titles):
                if title is None:
                    continue
                url = f"/detail/{s.get('detailDate', d)}/{s['id']}-{idx}/"
                if url in seen and seen[url] != title:
                    dups.append(f'{url} 标题冲突: {seen[url][:15]} vs {title[:15]}')
                seen[url] = title
        if not order_ok:
            break
    if order_ok:
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
for w in warned:
    print('  WARN:', w)
sys.exit(1 if failed else 0)
