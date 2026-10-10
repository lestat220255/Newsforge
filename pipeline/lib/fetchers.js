// Newsforge 构建管线 — lib/fetchers.js：全部信源抓取器 + 板块候选收集
// 依赖 utils；被 edit / run 调用。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';
import { SECTIONS, SUPPLEMENT_MASTODON } from '../site-config.js';
import {
  DATA_DIR, headersFor, fetchText, isSafeUrl, toISO, sleep, pLimit, shortHash, isFresh,
} from './utils.js';

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '',
  // 实体展开上限：默认 1000，HTML 实体多的源（如 MyGoPen、Simon Willison）会超限误杀；
  // 提到 20000，仍远低于十亿笑话攻击量级（百万级），保留 DoS 防护
  processEntities: { enabled: true, maxTotalExpansions: 20000 } });

// URL 安全校验（2026-10-07）：只接受 http/https 协议，挡 javascript:/data: 等伪协议投毒

function parseRSS(xml, source) {
  const items = [];
  try {
    const doc = xmlParser.parse(xml);
    const channel = doc.rss?.channel || doc.feed;
    if (!channel) return items;
    let entries = channel.item || channel.entry || [];
    if (!Array.isArray(entries)) entries = [entries];
    for (const e of entries.slice(0, 30)) {
      const rawTitle = e.title;
      const title = typeof rawTitle === 'string' ? rawTitle : rawTitle?.['#text'] || rawTitle?.['_'] || '';
      let link = '';
      if (typeof e.link === 'string') link = e.link;
      else if (Array.isArray(e.link)) link = e.link.find((l) => l.rel === 'alternate')?.href || e.link[0]?.href || '';
      else if (e.link?.href) link = e.link.href;
      const pub = toISO(e.pubDate || e.published || e.updated);
      // guid：去重主键（无 guid 时回退到 url）
      const rawGuid = e.guid;
      const guid = typeof rawGuid === 'string' ? rawGuid.trim() : rawGuid?.['#text'] || rawGuid?.['_'] || '';
      // 作者：dc:creator / author
      const rawAuthor = e['dc:creator'] || e.author || '';
      const authorStr = typeof rawAuthor === 'string' ? rawAuthor.trim() : '';
      // 图片：media:content / media:thumbnail / enclosure
      let img = '';
      const m = e['media:content'] || e['media:thumbnail'] || e.enclosure;
      const pickUrl = (o) => (o && typeof o === 'object' ? o.url || o.href : '');
      if (Array.isArray(m)) img = pickUrl(m.find((x) => pickUrl(x))) || '';
      else img = pickUrl(m) || '';
      if (title && link && isSafeUrl(link))
        items.push({ title: String(title).trim(), url: link, guid: guid || undefined, source, publishedAt: pub, image: img || undefined, author: authorStr || undefined });
    }
  } catch (e) {
    console.warn(`[rss] 解析失败 ${source}: ${e.message}`);
  }
  return items;
}

async function fetchRSS(url, source) {
  // 失败时抛出（保留日志），由 fetchOne 统一记录进信源健康追踪
  try {
    return parseRSS(await fetchText(url), source);
  } catch (e) {
    console.warn(`[rss] 抓取失败 ${source}: ${e.message}`);
    throw e;
  }
}

async function fetchWebList(s) {
  // weblist（借鉴 AIHOT web_list）：无 RSS 的列表页，CSS 选择器抓取
  // s: { url, itemSelector, linkSelector?, titleSelector?, publishedAtSelector?, summarySelector? }
  try {
    const html = await fetchText(s.url);
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();
    $(s.itemSelector).each((_, el) => {
      const root = $(el);
      const linkEl = s.linkSelector
        ? root.find(s.linkSelector).first()
        : (root.is('a') ? root : root.find('a').first());
      const href = linkEl.attr('href');
      if (!href) return;
      let url;
      try { url = new URL(href, s.url).href; } catch { return; }
      if (seen.has(url)) return;
      seen.add(url);
      const title = s.titleAttr
        ? (linkEl.attr(s.titleAttr) || '').trim()
        : (s.titleSelector ? root.find(s.titleSelector).first().text() : linkEl.text())
            .trim().replace(/\s+/g, ' ');
      if (!title) return;
      let dateText = s.publishedAtSelector ? root.find(s.publishedAtSelector).first().text().trim() : '';
      // 中日日期归一化：2026年3月27日 → 2026-3-27（JS Date 解析不了 CJK 格式）
      dateText = dateText.replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/, '$1-$2-$3');
      const summary = s.summarySelector
        ? root.find(s.summarySelector).first().text().trim().replace(/\s+/g, ' ').slice(0, 200)
        : '';
      items.push({ title, url, source: s.name, publishedAt: toISO(dateText), summary });
    });
    return items.slice(0, 30);
  } catch (e) {
    console.warn(`[weblist] 抓取失败 ${s.name}: ${e.message}`);
    throw e;
  }
}

// 信源健康追踪（借鉴 AIHOT 信源健康）：记录每次抓取的硬失败，连续 3 天失败标"失血"
// 超时（abort/timeout）多为本机并发挤爆出口所致，真源直连正常，故记为中性、不计入 fails

const healthRun = {}; // key: `${sectionId}::${sourceName}` -> { st: 'ok' | 'fail' | 'timeout', err }
function recordHealth(key, st, errMsg) {
  healthRun[key] = { st, err: (errMsg || '').slice(0, 120) };
}
const isTimeoutErr = (m) => /abort|timeout|timed out/i.test(m || '');

function updateSourceHealth(today) {
  const hp = join(DATA_DIR, 'source-health.json');
  let health = {};
  try { health = JSON.parse(readFileSync(hp, 'utf8')); } catch {}
  const changes = [];
  for (const [key, r] of Object.entries(healthRun)) {
    const h = health[key] || { fails: 0, status: 'ok', lastOk: null, lastFail: null };
    if (r.st === 'ok') {
      if (h.status === 'dead') changes.push(`恢复: ${key}`);
      h.fails = 0; h.status = 'ok'; h.lastOk = today;
    } else if (r.st === 'timeout') {
      h.lastTimeout = today; // 中性：不增不减，只留痕
    } else {
      h.fails = (h.fails || 0) + 1; h.lastFail = today; h.lastErr = r.err;
      if (h.fails >= 3 && h.status !== 'dead') {
        h.status = 'dead';
        changes.push(`新增失血: ${key}（连续 ${h.fails} 天失败：${r.err}）`);
      }
    }
    health[key] = h;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(hp, JSON.stringify(health, null, 2));
  for (const c of changes) console.log(`[health] ${c}`);
  const dead = Object.entries(health).filter(([, h]) => h.status === 'dead');
  if (dead.length) console.log(`[health] 当前失血 ${dead.length} 个: ${dead.map(([k]) => k).join(', ')}`);
}

async function fetchGitHubReleases(repo, source) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
      headers: { ...UA, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data
      .filter((r) => !r.draft && !r.prerelease)
      .slice(0, 5)
      .map((r) => ({
        title: `${repo} 发布 ${r.tag_name}`,
        url: r.html_url,
        source,
        publishedAt: toISO(r.published_at),
      }));
  } catch (e) {
    console.warn(`[github] ${repo} 失败: ${e.message}`);
    throw e;
  }
}

async function fetchGitHubTrending(source) {
  // 近 7 天新建、按 star 排序（GitHub 官方 Search API，无需鉴权，每小时 60 次限额内）
  try {
    const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const res = await fetch(
      `https://api.github.com/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=12`,
      { headers: { ...UA, Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.items || []).map((r) => ({
      title: `${r.full_name}（+${r.stargazers_count} star）`,
      url: r.html_url,
      source,
      publishedAt: toISO(r.created_at),
      summary: r.description || '',
    }));
  } catch (e) {
    console.warn(`[github_trending] 失败: ${e.message}`);
    throw e;
  }
}

async function fetchHuggingFace(source) {
  // HuggingFace 官方 API：按 likes 排序的热门模型
  try {
    const res = await fetch('https://huggingface.co/api/models?sort=likes&direction=-1&limit=12', { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((m) => ({
      title: m.id,
      url: `https://huggingface.co/${m.id}`,
      source,
      publishedAt: toISO(m.lastModified || m.createdAt),
      summary: `${m.likes || 0} likes · ${(m.downloads || 0).toLocaleString()} downloads`,
    }));
  } catch (e) {
    console.warn(`[huggingface] 失败: ${e.message}`);
    throw e;
  }
}

async function fetchV2EX(node, source) {
  try {
    const res = await fetch(`https://www.v2ex.com/api/topics/show.json?node_name=${node}`, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).slice(0, 15).map((t) => ({
      title: t.title,
      url: t.url,
      source,
      publishedAt: toISO(t.created * 1000),
    }));
  } catch (e) {
    console.warn(`[v2ex] ${node} 失败: ${e.message}`);
    throw e;
  }
}

async function fetchReddit(sub, source) {
  try {
    const res = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=25`, {
      headers: { ...UA, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.data?.children || []).map((c) => ({
      title: c.data.title,
      url: 'https://www.reddit.com' + c.data.permalink,
      source,
      publishedAt: toISO(c.data.created_utc * 1000),
    }));
  } catch (e) {
    console.warn(`[reddit] r/${sub} 失败: ${e.message}`);
    throw e;
  }
}

async function gdeltSearch(query, source, retries = 2) {
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}` +
    `&mode=artlist&maxrecords=20&format=json&sortby=date`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.status === 429 && attempt < retries) {
        await sleep(6000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data.articles || [])
        .filter((a) => a.title && isSafeUrl(a.url))
        .map((a) => ({
          title: a.title,
          url: a.url,
          source: a.source || source,
          publishedAt: toISO(a.seendate),
        }));
    } catch (e) {
      if (attempt < retries) {
        await sleep(6000 * (attempt + 1));
        continue;
      }
      console.warn(`[gdelt] "${query}" 失败: ${e.message}`);
      return [];
    }
  }
  return [];
}

// Mastodon 趋势热榜（2026-10-07）：去中心化论坛补充源，各实例 /api/v1/trends/links 无需认证
// 实例级缓存：每轮构建每个实例最多请求一次（限流 300 次/5 分钟，绰绰有余）

const _mastodonCache = {};
async function fetchMastodonTrends(instance, name) {
  if (_mastodonCache[instance]) return _mastodonCache[instance];
  const p = (async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${instance}/api/v1/trends/links?limit=10`, {
        headers: UA,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const links = await res.json();
      const host = new URL(instance).host;
      return (Array.isArray(links) ? links : [])
        .filter((l) => l && l.title && isSafeUrl(l.url))
        .map((l) => ({
          title: String(l.title).trim(),
          url: l.url,
          guid: l.url,
          source: `${name}(${host})`,
          publishedAt: toISO(l.published_at),
          blurb: String(l.description || '').slice(0, 120),
          image: l.image || undefined,
          author: l.author_name || undefined,
        }));
    } catch (e) {
      console.log(`[mastodon] ${instance} 失败: ${e.message}`);
      return [];
    } finally {
      clearTimeout(t);
    }
  })();
  _mastodonCache[instance] = p;
  return p;
}

// 英国政府官网搜索 API（官方来源，JSON）

async function fetchGovUK(query, source) {
  try {
    const res = await fetch(
      `https://www.gov.uk/api/search.json?q=${encodeURIComponent(query)}&count=10`,
      { headers: UA },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.results || []).slice(0, 10).map((r) => ({
      title: r.title,
      url: r.link && r.link.startsWith('http') ? r.link : 'https://www.gov.uk' + r.link,
      source,
      publishedAt: toISO(r.public_timestamp),
    }));
  } catch (e) {
    console.warn(`[govuk] 失败: ${e.message}`);
    throw e;
  }
}

// 并发限制：避免同时发起过多请求导致被 abort/限流

let disabledCache = null;
function loadDisabledSources() {
  if (disabledCache) return disabledCache;
  try {
    disabledCache = JSON.parse(readFileSync(join(DATA_DIR, 'disabled-sources.json'), 'utf8'));
  } catch {
    disabledCache = {};
  }
  return disabledCache;
}
/** 源唯一 key：同名源加区分后缀（与 probe-sources.js 的 sourceKey 保持一致） */

function sourceKey(sectionId, s) {
  const base = `${sectionId}::${s.name}`;
  if (s.type === 'github' && s.repo) return `${base}@${s.repo}`;
  if (s.type === 'v2ex' && s.node) return `${base}@${s.node}`;
  if (s.type === 'reddit' && s.sub) return `${base}@r/${s.sub}`;
  if ((s.type === 'gdelt' || s.type === 'govuk') && s.query) return `${base}@q${shortHash(s.query)}`;
  return base;
}

async function collectSection(section, { skipGdelt = false } = {}) {
  const all = [];
  // 探针禁用的源直接跳过（2026-10-08）
  const disabled = loadDisabledSources();
  const activeSources = section.sources.filter((s) => {
    if (disabled[sourceKey(section.id, s)]) {
      console.log(`[${section.id}] 跳过已禁用源: ${s.name}`);
      return false;
    }
    return true;
  });
  const gdeltSources = activeSources.filter((s) => s.type === 'gdelt');
  const mainSources = activeSources.filter((s) => s.type !== 'gdelt');
  // 主力源并行抓取（单个失败不影响其他）
  // 超时重试（2026-10-10）：10 板块并行时出口拥塞，大页面 weblist 常被 25s 超时误杀；
  // 04:00 串行探针证实这些源本身健康，故超时后错峰重试一次（重试记 ok，不污染 fails）
  const fetchOne = async (s) => {
    const hkey = `${section.id}::${s.name}`;
    const doFetch = async () => {
      let items;
      if (s.type === 'rss') items = await fetchRSS(s.url, s.name);
      else if (s.type === 'weblist') items = await fetchWebList(s);
      else if (s.type === 'github') items = await fetchGitHubReleases(s.repo, s.name);
      else if (s.type === 'v2ex') items = await fetchV2EX(s.node, s.name);
      else if (s.type === 'reddit') items = await fetchReddit(s.sub, s.name);
      else if (s.type === 'govuk') items = await fetchGovUK(s.query, s.name);
      else if (s.type === 'github_trending') items = await fetchGitHubTrending(s.name);
      else if (s.type === 'huggingface') items = await fetchHuggingFace(s.name);
      else items = [];
      // 信源分级（2026-10-08，借鉴 AIHOT tier）：T1 官方一手，默认 T2
      const tier = s.tier || 'T2';
      for (const it of items) it.tier = tier;
      return items;
    };
    try {
      const items = await doFetch();
      recordHealth(hkey, 'ok');
      return items;
    } catch (e) {
      if (isTimeoutErr(e.message)) {
        // 超时：错峰 2-4s 后重试一次；重试成功记 ok，仍超时才记 timeout（中性，不增 fails）
        await sleep(2000 + Math.random() * 2000);
        try {
          const items = await doFetch();
          recordHealth(hkey, 'ok');
          console.log(`[${section.id}] 源 ${s.name} 超时重试成功`);
          return items;
        } catch (e2) {
          recordHealth(hkey, isTimeoutErr(e2.message) ? 'timeout' : 'fail', e2.message);
          console.log(`[${section.id}] 源 ${s.name} 失败(含重试): ${e2.message}`);
          return [];
        }
      }
      recordHealth(hkey, 'fail', e.message);
      console.log(`[${section.id}] 源 ${s.name} 失败: ${e.message}`);
      return [];
    }
  };
  const results = await pLimit(mainSources.map((s) => () => fetchOne(s)), 6);
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.log(`[${section.id}] 源抓取异常: ${r.reason?.message || r.reason}`);
  }
  const seen = new Set();
  const dedupKey = (it) => it.guid || it.url; // guid 优先（2026-10-07）：同一文章 URL 变化时仍能去重
  const deduped = all.filter((it) => {
    if (!it.url || seen.has(dedupKey(it))) return false;
    seen.add(dedupKey(it));
    return true;
  });
  // GDELT 降级为补充：主力源候选不足 10 条时才抓取，并标记来源优先级
  const supplementItems = [];
  if (deduped.length < 10 && !skipGdelt && gdeltSources.length) {
    console.log(`[${section.id}] 主力源仅 ${deduped.length} 条，启用 GDELT 补充`);
    for (const s of gdeltSources) {
      await sleep(5000); // GDELT 官方限流：每 5 秒最多 1 次请求
      const items = await gdeltSearch(s.query, s.name);
      for (const it of items) {
        if (!it.url || seen.has(dedupKey(it))) continue;
        seen.add(dedupKey(it));
        supplementItems.push({ ...it, supplement: true });
      }
    }
  }
  // Mastodon 趋势补充（2026-10-07）：同 GDELT 降级机制，主力源不足时才抓（实例级缓存，每轮最多 2 次请求）
  if (deduped.length < 10) {
    for (const s of SUPPLEMENT_MASTODON) {
      if (disabled[`supplement::${s.instance}`]) {
        console.log(`[${section.id}] 跳过已禁用源: ${s.name}(${s.instance})`);
        continue;
      }
      const items = await fetchMastodonTrends(s.instance, s.name);
      let added = 0;
      for (const it of items) {
        if (!it.url || seen.has(dedupKey(it))) continue;
        seen.add(dedupKey(it));
        supplementItems.push({ ...it, supplement: true });
        added++;
      }
      if (added) console.log(`[${section.id}] Mastodon 趋势补充 ${added} 条 (${s.instance})`);
    }
  }
  const final = [...deduped, ...supplementItems];
  final.sort((a, b) => ((b.publishedAt || '') > (a.publishedAt || '') ? 1 : -1));
  return final;
}

// ---------------- LLM ----------------

async function fetchCandidates({ today, onlyIds = null, skipGdelt = false } = {}) {
  console.log(`Newsforge 抓取开始，日期 ${today}`);
  if (onlyIds) console.log(`[sections] 仅抓取: ${onlyIds.join(',')}`);
  const candPath = join(DATA_DIR, 'candidates', `${today}.json`);
  // 断点续抓：undici 偶发底层断言崩溃（服务器提前断开 TLS）会直接杀掉进程，
  // 因此每完成一个板块就落盘一次；同日重复运行自动跳过已完成的板块
  const done = {};
  if (existsSync(candPath)) {
    try {
      const prev = JSON.parse(readFileSync(candPath, 'utf8'));
      if (prev.date === today) {
        for (const s of prev.sections || []) done[s.id] = s;
        console.log(`[resume] 发现已有 ${Object.keys(done).length} 个板块: ${Object.keys(done).join(',')}`);
      }
    } catch (e) {
      console.warn(`[resume] 读取已有候选失败，将重新抓取: ${e.message}`);
    }
  }
  const sections = [];
  // 先处理可跳过的板块，收集需抓取的
  const toFetch = [];
  for (const sec of SECTIONS) {
    if (done[sec.id] && !(onlyIds && onlyIds.includes(sec.id))) {
      // 分批抓取时：已完成的板块保留进文件，不重新抓取
      sections.push(done[sec.id]);
      continue;
    }
    if (onlyIds && !onlyIds.includes(sec.id)) continue;
    if (done[sec.id]) {
      console.log(`[${sec.id}] 已有 ${done[sec.id].candidates.length} 条候选，跳过`);
      sections.push(done[sec.id]);
      continue;
    }
    toFetch.push(sec);
  }
  // 板块并行抓取（单个板块失败不影响其他）
  // 并发上限 3（2026-10-10）：10 板块 × 6 源全并行时出口拥塞，10-10 构建 83 个源超时；
  // 串行探针证实源本身健康，降并发即治本（峰值并发 60 → 18）
  const fetchResults = await pLimit(
    toFetch.map((sec) => async () => {
      const candidates = await collectSection(sec);
      const fresh = candidates.filter((c) => isFresh(c.publishedAt));
      console.log(`[${sec.id}] 候选 ${candidates.length} 条，其中 36h 内 ${fresh.length} 条`);
      return { id: sec.id, name: sec.name, desc: sec.desc, candidates };
    }),
    3,
  );
  for (let i = 0; i < toFetch.length; i++) {
    const sec = toFetch[i];
    const r = fetchResults[i];
    if (r.status === 'fulfilled') {
      done[sec.id] = r.value;
      sections.push(r.value);
    } else {
      console.log(`[${sec.id}] 板块抓取失败: ${r.reason?.message || r.reason}，该板块本期空缺`);
    }
  }
  // 按 SECTIONS 原顺序排列
  sections.sort((a, b) => SECTIONS.findIndex((s) => s.id === a.id) - SECTIONS.findIndex((s) => s.id === b.id));
  mkdirSync(join(DATA_DIR, 'candidates'), { recursive: true });
  writeFileSync(candPath, JSON.stringify({ date: today, sections }, null, 2));
  console.log(`候选已写入 data/candidates/${today}.json`);
  updateSourceHealth(today); // 信源健康追踪落盘（2026-10-08）
}

// ---------------- 图片管线（仅头条） ----------------
// 策略：RSS 自带图 → 文章页 og:image → 下载到本地 → 限宽800px + WebP + 去EXIF + <100KB
// 脱敏意义：不热链原站（防盗链/失效/慢），EXIF 默认剥离，文件随仓库走 Cloudflare CDN

export {
  fetchCandidates, collectSection,
  fetchRSS, fetchWebList, fetchGitHubReleases, fetchGitHubTrending, fetchHuggingFace,
  fetchV2EX, fetchReddit, gdeltSearch, fetchMastodonTrends, fetchGovUK,
  parseRSS, loadDisabledSources, updateSourceHealth, recordHealth, sourceKey,
};
