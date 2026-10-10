#!/usr/bin/env node
/**
 * Newsforge 构建管线：抓取 → LLM 摘要/点评 → 生成静态 HTML
 * 用法: node pipeline/run.js [--skip-llm] [--date=YYYY-MM-DD]
 *
 * 约定（来自需求对齐）：
 * - 每板块每天：1 头条（标题 + 200字内摘要 + 一句点评）+ 最多 5 条（标题 + 15字内摘要）
 * - 无新动向：沿用上一期整版；日期永远醒目标注；超 7 天换样式；抓取失败同样沿用
 * - 每条必须有来源链接（provenance 来自抓取，不由 LLM 编造）
 * - 只做公开资讯整理，不写操作教程
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { SECTIONS, SITE, FEATURES, SUPPLEMENT_MASTODON } from './site-config.js';
import { TOPICS, topicUrl, isValidTopic } from './topics.js';

// 启动时校验时区名：拼错立刻警告，不要静默回退
try {
  new Intl.DateTimeFormat('en-US', { timeZone: SITE.timezone || 'Asia/Shanghai' });
} catch {
  console.warn(`[warn] site.json 的 timezone "${SITE.timezone}" 非法，已回退为 Asia/Shanghai。请检查拼写（IANA 时区名，如 America/New_York）。`);
  SITE.timezone = 'Asia/Shanghai';
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');
const DATA_DIR = join(ROOT, 'data');
const EDITIONS_DIR = join(DATA_DIR, 'editions');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const SKIP_LLM = !!args['skip-llm'];
const SKIP_GDELT = !!args['skip-gdelt']; // GDELT 限流严重时跳过

// site.json → site.timezone（IANA，如 Asia/Shanghai）决定的"今天"。
// 用 Intl 算出该时区此刻相对 UTC 的偏移，保证本机、CI、Cloudflare Pages 三处日期一致。
function tzOffsetAt(t) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: SITE.timezone || 'Asia/Shanghai', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(dtf.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return asUTC - t;
  } catch {
    return 8 * 3600 * 1000; // 时区名非法时回退北京时间
  }
}
const TODAY = args.date || new Date(Date.now() + tzOffsetAt(Date.now())).toISOString().slice(0, 10);

const UA = { 'User-Agent': 'NewsforgeBot/0.1' };
// 个别站点（如 CBC）直接拒绝机器人 UA，连接会被重置；这些域名改用浏览器 UA 抓取
const BROWSER_UA = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
const BROWSER_UA_HOSTS = new Set(['www.cbc.ca', 'www.nasdaq.com', 'www.anthropic.com']);
function headersFor(url) {
  try { if (BROWSER_UA_HOSTS.has(new URL(url).hostname)) return BROWSER_UA; } catch {}
  return UA;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '',
  // 实体展开上限：默认 1000，HTML 实体多的源（如 MyGoPen、Simon Willison）会超限误杀；
  // 提到 20000，仍远低于十亿笑话攻击量级（百万级），保留 DoS 防护
  processEntities: { enabled: true, maxTotalExpansions: 20000 } });

// URL 安全校验（2026-10-07）：只接受 http/https 协议，挡 javascript:/data: 等伪协议投毒
function isSafeUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return false;
  try {
    const p = new URL(u.trim());
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch { return false; }
}

// ---------------- 抓取 ----------------
async function fetchText(url, timeoutMs = 25000) {
  const MAX_BODY = 5 * 1024 * 1024; // 响应体上限 5MB：防单个源返回超大文件拖慢构建
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: headersFor(url), signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = res.headers.get('content-length');
    if (len && +len > MAX_BODY) throw new Error(`响应体过大 (${len} bytes)`);
    // 无 Content-Length 时边读边限流：超限立刻取消，不让超大响应一次性进内存
    const chunks = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY) {
        reader.cancel();
        throw new Error(`响应体过大 (>${MAX_BODY} bytes)`);
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks);
    // 编码嗅探（2026-10-09）：部分中文站（汽车之家）用 GBK，res.text() 默认 UTF-8 会乱码
    let charset = 'utf-8';
    const ct = res.headers.get('content-type') || '';
    const m = ct.match(/charset=([\w-]+)/i);
    if (m) charset = m[1].toLowerCase();
    else {
      const head = buf.subarray(0, 4096).toString('latin1');
      const m2 = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
      if (m2) charset = m2[1].toLowerCase();
    }
    if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
      return new TextDecoder('gb18030').decode(buf);
    }
    return buf.toString('utf8');
  } finally {
    clearTimeout(t);
  }
}

function toISO(d) {
  try {
    const t = new Date(d);
    return isNaN(t.getTime()) ? null : t.toISOString();
  } catch {
    return null;
  }
}

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
function updateSourceHealth() {
  const hp = join(DATA_DIR, 'source-health.json');
  let health = {};
  try { health = JSON.parse(readFileSync(hp, 'utf8')); } catch {}
  const today = TODAY;
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
async function fetchGovUK(query, source) {  try {
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
async function pLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (e) {
        results[i] = { status: 'rejected', reason: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** 读禁用源列表（探针自动移除，2026-10-08）；key 见 sourceKey */
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
function shortHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16).slice(0, 8);
}
function sourceKey(sectionId, s) {
  const base = `${sectionId}::${s.name}`;
  if (s.type === 'github' && s.repo) return `${base}@${s.repo}`;
  if (s.type === 'v2ex' && s.node) return `${base}@${s.node}`;
  if (s.type === 'reddit' && s.sub) return `${base}@r/${s.sub}`;
  if ((s.type === 'gdelt' || s.type === 'govuk') && s.query) return `${base}@q${shortHash(s.query)}`;
  return base;
}

async function collectSection(section) {
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
  if (deduped.length < 10 && !SKIP_GDELT && gdeltSources.length) {
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
async function callLLM(section, items) {
  const { LLM_API_KEY, LLM_BASE_URL, LLM_MODEL } = process.env;
  if (!LLM_API_KEY) throw new Error('缺少 LLM_API_KEY 环境变量');
  const base = (LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const model = LLM_MODEL || 'deepseek-chat';
  const cand = items
    .slice(0, 20)
    .map(
      (it, i) =>
        `${i + 1}. ${it.title}\n   来源: ${it.source}${it.supplement ? ' [补充源·相关度可能较低]' : ''} | 时间: ${it.publishedAt || '未知'} | 链接: ${it.url}`,
    )
    .join('\n');
  const audience = SITE.audience ? `（面向${SITE.audience}）` : '';
  const headlineRule = section.editorial?.headlineRule
    ? `   头条权重规则（模块自定义，最高优先级）：${section.editorial.headlineRule}\n`
    : '';
  const prompt =
    `你是 Newsforge 资讯站${audience}的编辑。以下是「${section.name}」板块过去约 24 小时抓到的候选资讯。\n` +
    `请完成：\n` +
    `1. 选出 1 条头条 + 最多 5 条次条。标准：对读者最有用的"窗口 / 机会 / 重大变化"（板块定位：${section.desc}）。\n` +
    `   头条 48 小时规则：头条必须是 48 小时内发布的最新重要新闻；无够格头条则该板块隐藏（hidden:true）。\n` +
    `   信源要求：优先选择有多家媒体报道的新闻（至少两个独立信源）；实在只有一个信源也可收，但不要硬凑。\n   可信度权重（2026-10-07）：单信源且明确标注“未经证实/待确认”的新闻，可信度最低。头条不得选未证实新闻（无更优选项时宁可 hidden）；次条中未证实新闻排在已证实之后。JSON 里给每条加 "unverified": true/false。\n` +
    `   补充源降级：标注 [补充源] 的候选来自 GDELT 全网抓取或 Mastodon 趋势热榜，相关度噪音较大；主力源有够格条目时优先选主力源，补充源仅作备选。\n` +
    `   重要度：头条和次条都打 hot 标记（true=真正的热点才打，不要滥用）。\n` +
    headlineRule +
    `2. 标题译成简体中文；头条写 200 字以内中文摘要 + 一句编辑点评；次条写 15 字以内中文一句话摘要。\n` +
    `   摘要要求：不说空话套话（如"作为目前最主流的"）；必须包含一句话背景 + 这件事为什么重要。\n` +
    `   点评要求：给出实质判断，不做因果跳跃（不许拿个案推普遍规律），不押韵、不凑数；没什么可说的就写事实延伸。\n` +
    `   行文要求：只写报道明确说了什么；不写"报道暗示""或意味着"这类 AI 推断腔，不确定的写"待确认"。\n` +
    `3. 只做公开资讯整理，绝不写任何操作教程。\n` +
    `4. 每条的 url 必须原样沿用候选中的链接，绝不编造。\n` +
    `只输出 JSON（无其他文字）：\n` +
    `{"headline":{"title":"","url":"","source":"","publishedAt":"","summary":"","comment":"","hot":true,"unverified":false,"multi_source":false,"is_update":false},"items":[{"title":"","url":"","source":"","publishedAt":"","blurb":"","hot":true,"unverified":false,"multi_source":false,"is_update":false}],"hidden":false}\n` +
    `候选资讯：\n${cand}`;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  return JSON.parse(text);
}

function fallbackPick(items) {
  const top = items.slice(0, 4);
  if (!top.length) return { headline: null, items: [] };
  const [h, ...rest] = top;
  return {
    headline: {
      title: h.title,
      url: h.url,
      source: h.source,
      publishedAt: h.publishedAt,
      summary: '（AI 摘要暂不可用，请点击原文阅读）',
      comment: '',
    },
    items: rest.map((it) => ({
      title: it.title,
      url: it.url,
      source: it.source,
      publishedAt: it.publishedAt,
      blurb: it.source,
    })),
  };
}

// ---------------- 主流程 ----------------
function listEditions() {
  if (!existsSync(EDITIONS_DIR)) return [];
  return readdirSync(EDITIONS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

// 无时区的时间字符串一律按 site.json 的 timezone 解析。
// 根因（2026-10-08）：`new Date("2026-10-07T21:21:35")` 这类 naive 时间按本地时区解析，
// 本机是 Asia/Shanghai 而 Cloudflare Pages 是 UTC，导致两边次条排序/新鲜度判断不一致。
// 全站统一按配置时区解释，保证本地渲染与线上构建结果一致。
function parseTime(s) {
  if (!s) return NaN;
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(str)) {
    const local = str.replace(' ', 'T');
    const asUTC = Date.parse(local + 'Z');
    if (isNaN(asUTC)) return NaN;
    // 定点迭代：T = L - offset(T)。先按 UTC 猜，再用该时刻的偏移修正，最多 2 轮。
    // 已知局限：夏令时 fall-back 的重叠小时（同一本地时间出现两次）仍可能差一小时；
    // 排序/新鲜度只差一小时，不影响日期，可接受。
    let t = asUTC;
    for (let i = 0; i < 2; i++) {
      const t2 = asUTC - tzOffsetAt(t);
      if (t2 === t) break;
      t = t2;
    }
    return t;
  }
  return new Date(str).getTime();
}

function loadEdition(date) {
  try {
    const ed = JSON.parse(readFileSync(join(EDITIONS_DIR, `${date}.json`), 'utf8'));
    // 次条按发布时间倒序（新的在前），保证全站排序一致
    for (const sec of ed.sections || []) {
      if (sec.items) sec.items.sort((a, b) => ((a.unverified ? 1 : 0) - (b.unverified ? 1 : 0)) || ((parseTime(b.publishedAt) || 0) - (parseTime(a.publishedAt) || 0)));
    }
    return ed;
  } catch {
    return null;
  }
}

function isFresh(iso) {
  if (!iso) return false;
  const t = parseTime(iso);
  return !isNaN(t) && Date.now() - t < 36 * 3600 * 1000;
}
function isStale(iso) {
  if (!iso) return true;
  const t = parseTime(iso);
  return isNaN(t) || Date.now() - t > 7 * 24 * 3600 * 1000;
}

async function buildSection(section, prevSection) {
  const candidates = await collectSection(section);
  // 跨期去重（2026-10-10）：上一期已发布的 URL 不得再次入选。
  // 根因：isFresh 的 36h 窗口大于 24h 构建周期，昨天的条目今天仍算"新鲜"，AI 会整版复读且不走沿用逻辑。
  const prevUrls = new Set();
  if (prevSection) {
    const norm = (u) => String(u || '').split(/[?#]/)[0].replace(/\/$/, '');
    if (prevSection.headline?.url) prevUrls.add(norm(prevSection.headline.url));
    for (const it of prevSection.items || []) if (it.url) prevUrls.add(norm(it.url));
  }
  const normUrl = (u) => String(u || '').split(/[?#]/)[0].replace(/\/$/, '');
  const freshAll = candidates.filter((c) => isFresh(c.publishedAt));
  const fresh = freshAll.filter((c) => !prevUrls.has(normUrl(c.url)));
  console.log(`[${section.id}] 候选 ${candidates.length} 条，其中 36h 内 ${freshAll.length} 条，跨期去重后 ${fresh.length} 条`);
  if (fresh.length === 0) {
    if (prevSection && (prevSection.headline || (prevSection.items || []).length)) {
      // 沿用铁律（2026-10-07）：连续沿用不得超过 1 天，上一期已是沿用则隐藏，不断档复读
      if (prevSection.carried) {
        console.log(`[${section.id}] 已连续沿用一天，无新内容则隐藏`);
        return { id: section.id, name: section.name, desc: section.desc, headline: null, items: [], carried: false, hidden: true, empty: true };
      }
      console.log(`[${section.id}] 无新动向，沿用上一期`);
      return { ...prevSection, carried: true };
    }
    return { id: section.id, name: section.name, desc: section.desc, headline: null, items: [], carried: false, empty: true };
  }
  let picked;
  try {
    picked = SKIP_LLM ? fallbackPick(fresh) : await callLLM(section, fresh);
  } catch (e) {
    console.warn(`[${section.id}] LLM 失败，降级处理: ${e.message}`);
    picked = fallbackPick(fresh);
  }
  return {
    id: section.id,
    name: section.name,
    desc: section.desc,
    headline: picked.headline || null,
    items: picked.items || [],
    carried: false,
    updatedAt: TODAY,
  };
}

// ---------------- 渲染 ----------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 一键搜索（2026-10-07）：标题全文直跳 Google 搜索，AI Overview 可给出多方说法对照
function googleSearchUrl(title) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(String(title || ''));
}
// 防御：comment 字段若已带"AI 点评："前缀则剥离，避免渲染时与模板前缀叠成"AI 点评：AI 点评："
function cleanComment(s) {
  return String(s ?? '').replace(/^\s*AI\s*点评\s*[：:]\s*/, '');
}
function fmtDate(iso) {
  if (!iso) return '日期未知';
  const t = parseTime(iso);
  if (isNaN(t)) return '日期未知';
  return new Date(t + tzOffsetAt(t)).toISOString().slice(0, 10);
}
function dateBadge(iso) {
  const stale = isStale(iso);
  return `<span class="date${stale ? ' stale' : ''}" title="发布时间">${esc(fmtDate(iso))}${stale ? ' · 已超一周' : ''}</span>`;
}

// 详情页 URL：/detail/<日期>/<板块>-<序号>/（0=头条，1..n=次条）
function detailUrl(dDate, secId, idx) {
  return `/detail/${dDate}/${secId}-${idx}/`;
}
// 条目实际归属日期（沿用板块指向原日期）
function entryDate(ed, sec) {
  return sec.detailDate || ed.date;
}
// detailDate 铁律（2026-10-08）：沿用板块的 detailDate 必须一步到位指向详情页实际生成的日期，
// 禁止链式指向（A→B→C）。链式会让按单跳计算的归档/话题/首页链接指向不存在的 URL，形成静默死链。
// 构建时硬失败，不让坏数据上线；LLM 写 edition 时必须原样复制上一期的 detailDate。
function assertNoChainedDetailDate(dates) {
  const byDate = new Map();
  for (const d of dates) {
    const ed = loadEdition(d);
    if (ed) byDate.set(d, ed);
  }
  const bad = [];
  for (const [d, ed] of byDate) {
    for (const sec of ed.sections || []) {
      const dd = sec.detailDate;
      if (!dd || dd === d) continue;
      const target = byDate.get(dd);
      const tsec = target && (target.sections || []).find((s) => s.id === sec.id);
      const tdd = tsec ? tsec.detailDate || dd : null;
      if (!tsec) bad.push(`${d}/${sec.id}: detailDate=${dd} 指向的期数无此板块`);
      else if (tdd !== dd) bad.push(`${d}/${sec.id}: detailDate=${dd} 是链式指向（目标仍指向 ${tdd}），应直接写 ${tdd}`);
    }
  }
  if (bad.length) throw new Error('detailDate 校验失败，构建中止：\n' + bad.join('\n'));
}
// 来源行：媒体 · 作者 · 原文发布日期
function fmtDateCN(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function sourceLine(entry) {
  const parts = [entry.source];
  if (entry.author) parts.push(entry.author);
  const dt = fmtDateCN(entry.publishedAt);
  if (dt) parts.push(dt);
  return parts.filter(Boolean).join(' · ');
}

// 可信度徽标（2026-10-07）：unverified=单信源未证实→「待确认」；multi_source=多家独立媒体交叉报道→「多信源」
function trustBadges(e) {
  if (!e) return '';
  let s = '';
  if (e.unverified) s += '<span class="badge badge-pending">待确认</span>';
  if (e.multi_source) s += '<span class="badge badge-multi">多信源</span>';
  if (e.is_update) s += '<span class="badge badge-update">更新</span>';
  return s;
}
// 🔥 铁律（2026-10-07）：待确认条目永不带 🔥，模板层硬压制，AI 误标也不显示
function hotMark(e) {
  return e && e.hot && !e.unverified ? '🔥' : '';
}

// 图片宽高预读（2026-10-07）：构建时读 webp 实际尺寸，模板输出 width/height 防布局偏移
const IMG_DIMS = {};
async function preloadImgDims() {
  if (!existsSync(IMG_DIR)) return;
  // 注意：仓库里只有 .webp.b64（.webp 二进制是 gitignore 的），两种都要读
  const files = readdirSync(IMG_DIR).filter(f => f.endsWith('.webp') || f.endsWith('.webp.b64'));
  await Promise.all(files.map(async f => {
    try {
      const buf = f.endsWith('.b64')
        ? Buffer.from(readFileSync(join(IMG_DIR, f), 'utf8'), 'base64')
        : readFileSync(join(IMG_DIR, f));
      const meta = await sharp(buf).metadata();
      const name = f.endsWith('.b64') ? f.slice(0, -4) : f;
      if (meta.width && meta.height) IMG_DIMS['/images/' + name] = { w: meta.width, h: meta.height };
    } catch {}
  }));
}
function imgWH(src) {
  const d = src && IMG_DIMS[src];
  return d ? ` width="${d.w}" height="${d.h}"` : '';
}
function renderSection(sec, date) {
  const dDate = sec.detailDate || date;
  if (sec.empty || sec.hidden) {
    return '';
  }
  const h = sec.headline;
  const headHtml = h
    ? `<article class="headline"${h.sensitive ? ' data-sensitive="1"' : ''}>
      <div class="kicker">头条 ${sec.carried ? '<span class="carried">沿用前期版本</span>' : ''} ${dateBadge(h.publishedAt)}</div>
      ${h.image ? `<a class="himg-link" href="${detailUrl(dDate, sec.id, 0)}" aria-label="${esc(h.title)}"><img class="himg" src="${esc(h.image)}"${imgWH(h.image)} alt="" loading="lazy"></a>` : ''}
      <h3><a href="${detailUrl(dDate, sec.id, 0)}">${hotMark(h)}${esc(h.title)}${trustBadges(h)}</a></h3>
      <p class="summary">${esc(h.summary)}</p>
      ${h.comment ? `<p class="comment">AI 点评：${esc(cleanComment(h.comment))}</p>` : ''}
      <div class="meta">来源：${esc(sourceLine(h))} · <a href="${esc(h.url)}" target="_blank" rel="noopener" aria-label="阅读原文：${esc(h.title)}">阅读原文</a><button class="copy-btn" data-title="${esc(h.title)}" data-url="${esc(h.url)}" aria-label="复制标题和原文链接">复制</button><a class="search-btn" href="${esc(googleSearchUrl(h.title))}" target="_blank" rel="noopener" aria-label="在 Google 搜索此标题">搜索</a></div>
    </article>`
    : '';
  const itemsHtml = (sec.items || [])
    .map(
      (it, i) => `<li${it.sensitive ? ' data-sensitive="1"' : ''}>${dateBadge(it.publishedAt)}
      <span class="t"><a href="${detailUrl(dDate, sec.id, i + 1)}">${hotMark(it)}${esc(it.title)}${trustBadges(it)}</a></span>
      <span class="b">${esc(it.blurb || it.desc || '')}</span>
      <span class="s">${esc(it.source || '')}</span><button class="copy-btn" data-title="${esc(it.title)}" data-url="${esc(it.url)}" aria-label="复制标题和原文链接">复制</button><a class="search-btn" href="${esc(googleSearchUrl(it.title))}" target="_blank" rel="noopener" aria-label="在 Google 搜索此标题">搜索</a></li>`,
    )
    .join('');
  return `<section id="${esc(sec.id)}" data-pagefind-body>
    <h2>${esc(sec.name)}<small>${esc(sec.desc || '')}</small></h2>
    ${headHtml}
    ${itemsHtml ? `<ul class="secondary">${itemsHtml}</ul>` : ''}
  </section>`;
}

// 今日要览条（2026-10-08）：通栏分隔带；topPicks 只取 hot 头条、≤3 条、无则不渲染该模块
function renderDigest(edition) {
  const d = edition.dailyDigest;
  if (!d) return '';
  const picks = (d.topPicks || [])
    .map((p) => {
      const sec = edition.sections.find((s) => s.id === p.section);
      // 沿用板块一律不进入"今日最值得看"（2026-10-10）：模板层硬过滤，防 edition 手误写入
      if (!sec || sec.hidden || sec.empty || sec.carried) return '';
      const entry = p.index === 0 ? sec.headline : (sec.items || [])[p.index - 1];
      if (!entry) return '';
      const dDate = sec.detailDate || edition.date;
      return `<li${entry.sensitive ? ' data-sensitive="1"' : ''}><span class="sec-tag">${esc(sec.name)}</span><a href="${detailUrl(dDate, sec.id, p.index)}">${esc(entry.title)}</a></li>`;
    })
    .filter(Boolean)
    .join('');
  return `<div class="digest" data-pagefind-ignore>
    <div class="digest-top"><span class="digest-issue"><strong>第 ${d.issue} 期</strong>${esc(d.dateLabel)}</span><span class="digest-stats">${d.stats.items} 条更新 · ${d.stats.sources} 个来源 · 约 ${d.stats.readMinutes} 分钟读完</span></div>
    ${d.oneLiner ? `<p class="digest-oneliner">${esc(d.oneLiner)}</p>` : ''}
    ${picks ? `<div class="digest-picks"><div class="digest-picks-title">今日最值得看</div><ul>${picks}</ul></div>` : ''}
  </div>`;
}

function renderPage(tpl, edition, dates, canonical, showTgBanner) {
  const visibleSections = edition.sections.filter((s) => !s.empty && !s.hidden);
  const digestHtml = renderDigest(edition);
  const sectionsHtml = visibleSections.map((s) => renderSection(s, edition.date)).join('\n');
  const archiveOpts = (() => {
    // 按月分组（optgroup），日期多了以后下拉框好找
    const byMonth = {};
    for (const d of dates) {
      const m = d.slice(0, 7);
      (byMonth[m] = byMonth[m] || []).push(d);
    }
    return Object.keys(byMonth)
      .sort()
      .reverse()
      .map((m) => {
        const [y, mo] = m.split('-');
        const opts = byMonth[m]
          .map((d) => `<option value="/archive/${d}/"${d === edition.date ? ' selected' : ''}>${d}</option>`)
          .join('');
        return `<optgroup label="${y} 年 ${mo} 月">${opts}</optgroup>`;
      })
      .join('');
  })();
  const navLinks = visibleSections.map((s) => `<a href="#${esc(s.id)}">${esc(s.name)}</a>`).join('');
  // og:image：用第一个有配图的头条， fallback 到图标
  const firstImg = visibleSections.map((s) => s.headline?.image).find(Boolean);
  const ogImage = firstImg ? SITE.url + firstImg : SITE.url + '/favicon.svg';
  const tgOn = showTgBanner && FEATURES.telegram.enabled && FEATURES.telegram.channel;
  const tgBanner = tgOn ? `<div class="tg-banner" id="tg-banner"><span class="msg">📡 在 Telegram 上订阅 ${esc(SITE.name)}，每早同步推送当日头条</span><a class="sub-btn" href="https://t.me/${esc(FEATURES.telegram.channel)}" target="_blank" rel="noopener">订阅 →</a><button class="close" aria-label="关闭">×</button></div>` : '';
  return tpl
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SITE_URL}}', esc(SITE.url))
    .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
    .replaceAll('{{DATE}}', esc(edition.date))
    .replaceAll('{{CANONICAL}}', esc(canonical))
    .replaceAll('{{OG_IMAGE}}', esc(ogImage))
    .replaceAll('{{NAV}}', navLinks)
    .replaceAll('{{SECTIONS}}', sectionsHtml)
    .replaceAll('{{DIGEST}}', digestHtml)
    .replaceAll('{{ARCHIVE_OPTS}}', archiveOpts)
    .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer))
    .replaceAll('{{TG_BANNER}}', tgBanner)
    .replaceAll('{{BUILD_TIME}}', esc(new Date().toISOString()));
}

function shortTitle(t, n = 18) {
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 关键词提取：英文专有名词 + 中文3-4字短语（更具区分度）+ 核心2字词
function extractKeywords(text) {
  if (!text) return { strong: new Set(), weak: new Set() };
  const strong = new Set(), weak = new Set();
  // 英文词/数字：通常是专有名词，强信号
  (text.match(/[A-Za-z0-9]+(?:[.\-][A-Za-z0-9]+)*/g) || [])
    .filter((w) => w.length >= 3)
    .forEach((w) => strong.add(w.toLowerCase()));
  const cn = text.replace(/[^\u4e00-\u9fa5]/g, '');
  const stop = '的了在和与等为是有将已不也都而及或这那其之于对就但被把让向从到以因最更很太';
  // 3-4字短语：强信号；2字词：弱信号
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i <= cn.length - n; i++) {
      const w = cn.slice(i, i + n);
      if ([...w].some((c) => stop.includes(c))) continue;
      // 长词优先：若已被更长的词覆盖则跳过
      let covered = false;
      for (const s of strong) if (s.includes(w) && s !== w) { covered = true; break; }
      if (covered) continue;
      (n >= 3 ? strong : weak).add(w);
    }
  }
  return { strong, weak };
}

// 相关往期报道：强关键词(专有名词/3-4字短语)命中才算相关
// 同板块≥6分，跨板块≥8分，最多3条
// allArticles: [{date, secId, secName, idx, title, summary, url}]
function findRelated(cur, allArticles) {
  const curT = extractKeywords(cur.entry.title);
  const curS = extractKeywords(cur.entry.summary || '');
  const results = [];
  for (const a of allArticles) {
    if (a.date >= cur.date || (a.date === cur.date && a.secId === cur.sec.id && a.idx === cur.idx)) continue;
    const sameSec = a.secId === cur.sec.id;
    const aKw = a.kw;
    let strongHits = 0, score = sameSec ? 2 : 0;
    for (const w of curT.strong) if (aKw.strong.has(w)) { strongHits++; score += 3; }
    for (const w of curT.weak) if (aKw.strong.has(w) || aKw.weak.has(w)) score += 1;
    for (const w of curS.strong) if (aKw.strong.has(w)) score += 1;
    // 必须至少1个强关键词命中，否则不算相关
    if (!strongHits) continue;
    const threshold = sameSec ? 6 : 8;
    if (score >= threshold) results.push({ ...a, score });
  }
  // 兜底去重（2026-10-07）：按详情页 URL 去重后再取前 3，防止任何未知路径产生重复条目
  const uniq = [];
  const seenU = new Set();
  for (const r of results.sort((a, b) => b.score - a.score)) {
    if (seenU.has(r.url)) continue;
    seenU.add(r.url);
    uniq.push(r);
    if (uniq.length >= 3) break;
  }
  return uniq;
}

function renderDetail(tpl, ed, cur, prev, next, allArticles) {
  const { sec, idx, entry, isHeadline } = cur;
  const summary = isHeadline ? entry.summary || '' : entry.summary || entry.blurb || entry.desc || '';
  const analysisHtml = (entry.analysis || '暂无分析。')
    .split(/\n\n+/)
    .map((p) => `<p>${esc(p.trim())}</p>`)
    .join('\n      ');
  // 核心事实卡（2026-10-08）：长原文的 3-6 条关键事实，摘要之后、分析之前
  const keyFactsHtml = Array.isArray(entry.keyFacts) && entry.keyFacts.length
    ? `<section class="block"><h2>核心事实</h2><ul class="facts">` +
      entry.keyFacts.map((f) => `<li>${esc(String(f).trim())}</li>`).join('\n      ') +
      `</ul></section>`
    : '';
  const mainLink = `<li><a href="${esc(entry.url)}" target="_blank" rel="noopener">阅读原文：${esc(entry.title)}</a><span class="s">${esc(entry.source || '')}</span></li>`;
  const searchLink = `<li><a href="${esc(googleSearchUrl(entry.title))}" target="_blank" rel="noopener">在 Google 搜索此标题</a><span class="s">看多方报道与 AI 总结</span></li>`;
  // 相关往期报道：本站归档中同主题旧文（关键词匹配，同板块≥6分/跨板块≥8分）
  const related = findRelated({ ...cur, date: ed.date }, allArticles || []);
  const relatedHtml = related.length
    ? `<section class="block"><h2>相关往期报道</h2><ul class="links">` +
      related
        .map((r) => `<li><a href="${esc(r.url)}">${esc(r.title)}</a><span class="s">${esc(r.date)} · ${esc(r.secName)}</span></li>`)
        .join('\n      ') +
      `</ul></section>`
    : '';
  const pn = (item, label, cls) =>
    item
      ? `<a class="pn ${cls}" href="${item.url}">${label}：${esc(shortTitle(item.entry.title, 22))}</a>`
      : `<span class="pn ${cls} disabled">${label}（已是${cls === 'prev' ? '第一' : '最后'}篇）</span>`;
  const canonical = SITE.url + cur.url;
  // 面包屑/返回首页指向文章所属日期的归档页，而非当日首页（2026-10-06 修复）
  const archiveUrl = `/archive/${ed.date}/`;
  const ogImage = entry.image ? SITE.url + entry.image : (sec.headline && sec.headline.image ? SITE.url + sec.headline.image : SITE.url + '/favicon.svg');
  const ogDesc = summary.length > 140 ? summary.slice(0, 140) + '…' : summary;
  return tpl
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SEC_NAME}}', esc(sec.name))
    .replaceAll('{{SEC_ID}}', esc(sec.id))
    .replaceAll('{{TITLE}}', esc(entry.title))
    .replaceAll('{{TRUST_BADGES}}', trustBadges(entry) ? `<div class="trust-badges">${trustBadges(entry)}</div>` : '')
    .replaceAll('{{TITLE_SHORT}}', esc(shortTitle(entry.title)))
    .replaceAll('{{CANONICAL}}', esc(canonical))
    .replaceAll('{{ARCHIVE_URL}}', esc(archiveUrl))
    .replaceAll('{{SENSITIVE_ATTR}}', entry.sensitive ? ' data-sensitive="1"' : '')
    .replaceAll('{{OG_IMAGE}}', esc(ogImage))
    .replaceAll('{{OG_DESC}}', esc(ogDesc))
    .replaceAll('{{PUBLISHED_BADGE}}', dateBadge(entry.publishedAt))
    .replaceAll('{{TOPIC_TAGS}}', (entry.topics || []).filter(isValidTopic).length
      ? `<div class="topic-tags">` + (entry.topics || []).filter(isValidTopic).map(t =>
          `<a href="${esc(topicUrl(t))}">${esc(t)}</a>`).join('') + `</div>`
      : '')
    .replaceAll('{{SOURCE}}', esc(entry.source || ''))
    .replaceAll('{{URL}}', esc(entry.url))
    .replaceAll('{{DIMG}}', entry.image ? `<img class="dimg" src="${esc(entry.image)}"${imgWH(entry.image)} alt="" loading="lazy">` : '')
    .replaceAll('{{SUMMARY}}', esc(summary))
    .replaceAll('{{KEY_FACTS}}', keyFactsHtml)
    .replaceAll('{{ANALYSIS}}', analysisHtml)
    .replaceAll('{{LINKS}}', mainLink + '\n      ' + searchLink)
    .replaceAll('{{RELATED}}', relatedHtml)
    .replaceAll('{{PREV}}', pn(prev, '← 上一篇', 'prev'))
    .replaceAll('{{NEXT}}', pn(next, '下一篇 →', 'next'))
    .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer));
}

function renderDetailPages(dates) {
  const tpl = readFileSync(join(HERE, 'detail-template.html'), 'utf8');
  const urls = [];
  // 全站文章索引（供相关往期报道匹配）
  // 去重铁律（2026-10-07）：沿用（carried）板块保留原 detailDate，详情页 URL 与原版完全相同；
  // 若不按 URL 去重，同一篇文章会在索引里出现两次，"相关往期报道"就会显示重复条目
  const allArticles = [];
  const seenDetailUrls = new Set();
  const pushArticle = (a) => {
    if (seenDetailUrls.has(a.url)) return;
    seenDetailUrls.add(a.url);
    allArticles.push(a);
  };
  for (const d of dates) {
    const ed2 = loadEdition(d);
    if (!ed2) continue;
    for (const sec of ed2.sections) {
      if (sec.empty) continue;
      const dDate = entryDate(ed2, sec);
      if (sec.headline)
        pushArticle({ date: dDate, secId: sec.id, secName: sec.name, idx: 0, title: sec.headline.title, summary: sec.headline.summary || '', url: detailUrl(dDate, sec.id, 0), kw: extractKeywords(sec.headline.title + ' ' + (sec.headline.summary || '')) });
      (sec.items || []).forEach((it, i) =>
        pushArticle({ date: dDate, secId: sec.id, secName: sec.name, idx: i + 1, title: it.title, summary: it.summary || '', url: detailUrl(dDate, sec.id, i + 1), kw: extractKeywords(it.title + ' ' + (it.summary || '')) }),
      );
    }
  }
  for (const d of dates) {
    const ed = loadEdition(d);
    if (!ed) continue;
    // 当天首页展示顺序：板块顺序 → 头条(0) → 次条(1..n)
    const order = [];
    for (const sec of ed.sections) {
      if (sec.empty) continue;
      const dDate = entryDate(ed, sec);
      const gen = dDate === d; // 沿用板块的详情页已在原日期生成过，不重复生成
      if (sec.headline) order.push({ sec, idx: 0, entry: sec.headline, isHeadline: true, url: detailUrl(dDate, sec.id, 0), gen });
      (sec.items || []).forEach((it, i) =>
        order.push({ sec, idx: i + 1, entry: it, isHeadline: false, url: detailUrl(dDate, sec.id, i + 1), gen }),
      );
    }
    order.forEach((cur, pos) => {
      if (!cur.gen) return;
      // 上一篇/下一篇只在同板块内，不跨板块
      const sameSec = order.filter((o) => o.sec.id === cur.sec.id);
      const si = sameSec.findIndex((o) => o.idx === cur.idx);
      const prev = si > 0 ? sameSec[si - 1] : null;
      const next = si < sameSec.length - 1 ? sameSec[si + 1] : null;
      const html = renderDetail(tpl, ed, cur, prev, next, allArticles);
      const dir = join(DIST, 'detail', d, `${cur.sec.id}-${cur.idx}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), html);
      urls.push({ loc: SITE.url + cur.url, lastmod: d });
    });
  }
  console.log('详情页渲染完成');
  return urls;
}

async function fetchCandidates() {
  console.log(`Newsforge 抓取开始，日期 ${TODAY}`);
  const onlyIds = args.sections
    ? String(args.sections).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  if (onlyIds) console.log(`[sections] 仅抓取: ${onlyIds.join(',')}`);
  const candPath = join(DATA_DIR, 'candidates', `${TODAY}.json`);
  // 断点续抓：undici 偶发底层断言崩溃（服务器提前断开 TLS）会直接杀掉进程，
  // 因此每完成一个板块就落盘一次；同日重复运行自动跳过已完成的板块
  const done = {};
  if (existsSync(candPath)) {
    try {
      const prev = JSON.parse(readFileSync(candPath, 'utf8'));
      if (prev.date === TODAY) {
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
  writeFileSync(candPath, JSON.stringify({ date: TODAY, sections }, null, 2));
  console.log(`候选已写入 data/candidates/${TODAY}.json`);
  updateSourceHealth(); // 信源健康追踪落盘（2026-10-08）
}

// ---------------- 图片管线（仅头条） ----------------
// 策略：RSS 自带图 → 文章页 og:image → 下载到本地 → 限宽800px + WebP + 去EXIF + <100KB
// 脱敏意义：不热链原站（防盗链/失效/慢），EXIF 默认剥离，文件随仓库走 Cloudflare CDN
const IMG_DIR = join(ROOT, 'public', 'images');
const IMG_MAX_W = 800;
const IMG_MAX_BYTES = 90 * 1024; // base64 文本经 MCP 推送，单参数上限 128KB，留余量
const IMG_KEEP_DAYS = 90;
const CAND_KEEP_DAYS = 7;

async function fetchOgImage(pageUrl) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(pageUrl, { headers: headersFor(pageUrl), signal: ctl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!res.ok) return '';
    const html = await res.text();
    // og:image（兼容属性顺序颠倒）
    let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!m) return '';
    const abs = new URL(m[1], pageUrl).href;
    if (abs.startsWith('data:')) return '';
    // 站标过滤（2026-10-09）：有些站的 og:image 是站标占位图（如汽车之家的 opg_400_400.png），抓下来当配图会被读者当"图挂了"
    if (/logo|opg_|placeholder|default|avatar/i.test(abs)) return '';
    return abs;
  } catch {
    return '';
  }
}

async function downloadAndProcess(imgUrl, destPath) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const res = await fetch(imgUrl, { headers: headersFor(imgUrl), signal: ctl.signal, redirect: 'follow' });
    clearTimeout(t);
    if (!res.ok) return false;
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8 * 1024) return false; // 太小可能是 tracking pixel
    let quality = 72;
    let out = null;
    while (quality >= 40) {
      out = await sharp(buf)
        .resize({ width: IMG_MAX_W, withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
      if (out.length <= IMG_MAX_BYTES) break;
      quality -= 10;
    }
    if (!out || out.length > IMG_MAX_BYTES) return false;
    const meta = await sharp(out).metadata();
    if (!meta.width || meta.width < 300) return false;
    mkdirSync(IMG_DIR, { recursive: true });
    writeFileSync(destPath, out);
    // 同时写一份 base64 文本版（.b64）用于提交到 git：MCP 文本通道无法传输二进制
    writeFileSync(destPath + '.b64', out.toString('base64'));
    return true;
  } catch (e) {
    console.warn(`[image] 处理失败 ${imgUrl.slice(0, 60)}: ${e.message}`);
    return false;
  }
}

// 为某期头条配图；幂等：已有 image 字段的跳过
async function processEditionImages(date) {
  const edPath = join(EDITIONS_DIR, `${date}.json`);
  if (!existsSync(edPath)) {
    console.log(`[image] ${date} 无 edition 文件，跳过`);
    return;
  }
  const ed = JSON.parse(readFileSync(edPath, 'utf8'));
  let cands = null;
  try {
    cands = JSON.parse(readFileSync(join(DATA_DIR, 'candidates', `${date}.json`), 'utf8'));
  } catch { /* 无候选文件则只用 og:image */ }
  const candByUrl = {};
  if (cands) for (const s of cands.sections || []) for (const c of s.candidates || []) if (c.url && c.image) candByUrl[c.url] = c.image;

  let done = 0;
  // 头条图片并行处理（单个失败不影响其他）
  const imgJobs = [];
  const imgName = (secId, suffix) => `/images/${date}-${secId}-${suffix}.webp`;
  for (const sec of ed.sections) {
    const h = sec.headline;
    if (!h || h.image) continue;
    const dest = join(IMG_DIR, `${date}-${sec.id}-0.webp`);
    if (existsSync(dest)) {
      h.image = imgName(sec.id, '0');
      done++;
      continue;
    }
    imgJobs.push({ sec, h, dest, label: `${sec.id}头条`, suffix: '0' });
  }
  // hot 次条同样配图（2026-10-08 起）：只用于详情页展示 + OG 卡片，首页不显示
  for (const sec of ed.sections) {
    (sec.items || []).forEach((it, idx) => {
      if (!it.hot || it.image) return;
      const dest = join(IMG_DIR, `${date}-${sec.id}-s${idx}.webp`);
      if (existsSync(dest)) {
        it.image = imgName(sec.id, `s${idx}`);
        done++;
        return;
      }
      imgJobs.push({ sec, h: it, dest, label: `${sec.id}次条${idx}`, suffix: `s${idx}` });
    });
  }
  const imgResults = await Promise.allSettled(
    imgJobs.map(async ({ sec, h, dest, label, suffix }) => {
      let imgUrl = candByUrl[h.url] || '';
      if (!imgUrl) {
        console.log(`[image] ${label} RSS 无图，抓 og:image: ${h.url.slice(0, 70)}`);
        imgUrl = await fetchOgImage(h.url);
      }
      if (imgUrl && (await downloadAndProcess(imgUrl, dest))) {
        h.image = imgName(sec.id, suffix);
        console.log(`[image] ${label} 配图成功`);
        return true;
      }
      console.log(`[image] ${label} 无可用图片，跳过`);
      return false;
    }),
  );
  for (const r of imgResults) if (r.status === 'fulfilled' && r.value) done++;
  writeFileSync(edPath, JSON.stringify(ed, null, 2));
  console.log(`[image] ${date} 配图完成 ${done} 张（头条 + hot 次条）`);
  pruneOldFiles();
}

// 保留策略：图片 90 天，candidates 7 天（构建时自动清理）
function pruneOldFiles() {
  const now = Date.now();
  if (existsSync(IMG_DIR)) {
    for (const f of readdirSync(IMG_DIR)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})-/);
      if (!m) continue;
      if (now - new Date(m[1]).getTime() > IMG_KEEP_DAYS * 864e5) {
        try { unlinkSync(join(IMG_DIR, f)); console.log(`[prune] 删除过期图片 ${f}`); } catch {}
        // 同步删除对应的 .b64 / .webp 配对文件
        const pair = f.endsWith('.b64') ? f.slice(0, -4) : f + '.b64';
        try { unlinkSync(join(IMG_DIR, pair)); } catch {}
      }
    }
  }
  const candDir = join(DATA_DIR, 'candidates');
  if (existsSync(candDir)) {
    for (const f of readdirSync(candDir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      if (now - new Date(m[1]).getTime() > CAND_KEEP_DAYS * 864e5) {
        try { unlinkSync(join(candDir, f)); console.log(`[prune] 删除过期候选 ${f}`); } catch {}
      }
    }
  }
}

function rfc2822(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

// RSS：只收录最新一期，头条+次条全进，链接指向本站详情页
function renderFeedXml(edition) {
  const items = [];
  for (const sec of edition.sections) {
    if (sec.empty) continue;
    const dDate = sec.detailDate || edition.date;
    const pushItem = (entry, idx, isHeadline) => {
      const summary = isHeadline ? entry.summary || '' : entry.summary || entry.blurb || entry.desc || '';
      let desc = `<p><strong>${esc(sec.name)}</strong></p>`;
      if (summary) desc += `<p>${esc(summary)}</p>`;
      if (isHeadline && entry.comment) desc += `<p>AI 点评：${esc(cleanComment(entry.comment))}</p>`;
      const link = SITE.url + detailUrl(dDate, sec.id, idx);
      items.push({ title: entry.title || '(无标题)', link, desc, pubDate: rfc2822(entry.publishedAt) });
    };
    if (sec.headline) pushItem(sec.headline, 0, true);
    (sec.items || []).forEach((it, i) => pushItem(it, i + 1, false));
  }
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n` +
    `<title>${esc(SITE.name)}</title>\n<link>${esc(SITE.url + '/')}</link>\n` +
    `<description>${esc(SITE.tagline)}</description>\n<language>zh-CN</language>\n` +
    `<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n` +
    items
      .map(
        (it) =>
          `<item>\n<title>${esc(it.title)}</title>\n<link>${esc(it.link)}</link>\n` +
          `<guid>${esc(it.link)}</guid>\n<pubDate>${it.pubDate}</pubDate>\n` +
          `<description><![CDATA[${it.desc}]]></description>\n</item>`,
      )
      .join('\n') +
    `\n</channel>\n</rss>\n`;
  writeFileSync(join(DIST, 'feed.xml'), xml);
  console.log(`RSS 已生成：${items.length} 条`);
}

// 归档索引页：/archive/，按月分组折叠（<details>），每组内按日期倒序，每期列头条标题+摘要
function renderArchiveIndex(allDates) {
  const tpl = readFileSync(join(HERE, 'archive-index-template.html'), 'utf8');
  // 按月分组：{ 'YYYY-MM': [dates...] }，日期已是倒序
  const byMonth = {};
  for (const d of allDates) {
    const m = d.slice(0, 7);
    (byMonth[m] = byMonth[m] || []).push(d);
  }
  const months = Object.keys(byMonth).sort().reverse();
  const blocks = months
    .map((m, mi) => {
      const [y, mo] = m.split('-');
      const sections = byMonth[m]
        .map((d) => {
          const ed = loadEdition(d);
          if (!ed) return '';
          const heads = [];
          for (const sec of ed.sections) {
            if (sec.empty || !sec.headline) continue;
            const dDate = sec.detailDate || d;
            const h = sec.headline;
            heads.push(
              `<li><span class="sec">${esc(sec.name)}</span>` +
                `<span class="t"><a href="${detailUrl(dDate, sec.id, 0)}">${esc(h.title)}${trustBadges(h)}</a></span>` +
                (h.summary ? `<p class="sum">${esc(h.summary)}</p>` : '') +
                `</li>`,
            );
          }
          if (!heads.length) return '';
          return (
            `<section class="ed"><h2><a href="/archive/${d}/">${d}</a>` +
            `<span class="cnt">${heads.length} 条头条</span></h2>\n` +
            `<ul class="hl">\n${heads.join('\n')}\n</ul></section>`
          );
        })
        .filter(Boolean)
        .join('\n');
      if (!sections) return '';
      const cnt = byMonth[m].length;
      return (
        `<details class="month"${mi === 0 ? ' open' : ''}>` +
        `<summary>${y} 年 ${mo} 月<span class="mcnt">${cnt} 期</span></summary>\n` +
        sections +
        `</details>`
      );
    })
    .join('\n');
  const html = tpl
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SITE_URL}}', esc(SITE.url))
    .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
    .replaceAll('{{ARCHIVE_LIST}}', blocks || '<p>暂无归档</p>')
    .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer))
    .replaceAll('{{BUILD_TIME}}', esc(new Date().toISOString()));
  mkdirSync(join(DIST, 'archive'), { recursive: true });
  writeFileSync(join(DIST, 'archive', 'index.html'), html);
  console.log('归档索引页已生成');
}

function renderTopicPages(dates) {
  // 收集所有带话题的文章，按话题分组
  const byTopic = new Map(); // topicName -> [{date, secName, secId, title, url, publishedAt}]
  for (const d of dates) {
    const ed = loadEdition(d);
    if (!ed) continue;
    for (const sec of ed.sections || []) {
      if (sec.hidden) continue;
      const secName = sec.name || '';
      const secId = sec.id || '';
      const entries = [];
      if (sec.headline) entries.push({ ...sec.headline, isHeadline: true });
      for (const it of sec.items || []) entries.push({ ...it, isHeadline: false });
      for (const e of entries) {
        const topics = (e.topics || []).filter(isValidTopic);
        if (!topics.length) continue;
        // 详情页 URL：/detail/<date>/<secId>-<idx>/（沿用板块必须用 detailDate，否则链出的 URL 与实际生成的对不上）
        const idx = e.isHeadline ? 0 : (sec.items || []).findIndex(it => it.url === e.url) + 1;
        const dDate = sec.detailDate || d;
        const durl = `/detail/${dDate}/${secId}-${idx}/`;
        for (const t of topics) {
          if (!byTopic.has(t)) byTopic.set(t, []);
          byTopic.get(t).push({
            date: d, secName, title: e.title || '',
            url: durl, publishedAt: e.publishedAt || '',
            unverified: !!e.unverified, multi_source: !!e.multi_source, is_update: !!e.is_update,
          });
        }
      }
    }
  }
  const topicUrls = [];
  const tpl = readFileSync(join(HERE, 'topic-template.html'), 'utf8');
  const BUILD_TIME = new Date().toISOString();
  // 按话题名排序，保证稳定输出
  const sortedTopics = [...byTopic.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  for (const tname of sortedTopics) {
    const articles = byTopic.get(tname)
      .sort((a, b) => (b.publishedAt || '') > (a.publishedAt || '') ? 1 : -1);
    const listHtml = articles.map(a =>
      `<div class="arch-item"><span class="d">${esc(a.date)}</span> <span class="s">[${esc(a.secName)}]</span> <a href="${esc(a.url)}">${esc(a.title)}${trustBadges(a)}</a></div>`
    ).join('\n');
    const url = SITE.url + topicUrl(tname);
    const html = tpl
      .replaceAll('{{SITE_NAME}}', esc(SITE.name))
      .replaceAll('{{SITE_URL}}', esc(SITE.url))
      .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
      .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer))
      .replaceAll('{{TOPIC_NAME}}', esc(tname))
      .replaceAll('{{TOPIC_URL}}', esc(url))
      .replaceAll('{{TOPIC_ARTICLES}}', listHtml)
      .replaceAll('{{BUILD_TIME}}', esc(BUILD_TIME));
    const dir = join(DIST, 'topic', tname);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), html);
    topicUrls.push({ loc: url, lastmod: articles[0]?.date || '' });
  }
  // 话题索引页 /topics/
  const idxTpl = readFileSync(join(HERE, 'topics-index-template.html'), 'utf8');
  const topicsListHtml = sortedTopics.map(tname => {
    const n = byTopic.get(tname).length;
    return `<div class="arch-item"><a href="${esc(topicUrl(tname))}">${esc(tname)}</a> <span class="s">${n} 篇</span></div>`;
  }).join('\n') || '<p>暂无话题。</p>';
  const idxHtml = idxTpl
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SITE_URL}}', esc(SITE.url))
    .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
    .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer))
    .replaceAll('{{TOPICS_LIST}}', topicsListHtml)
    .replaceAll('{{BUILD_TIME}}', esc(BUILD_TIME));
  mkdirSync(join(DIST, 'topics'), { recursive: true });
  writeFileSync(join(DIST, 'topics', 'index.html'), idxHtml);
  topicUrls.push({ loc: SITE.url + '/topics/', lastmod: '' });
  console.log(`话题页渲染完成：${sortedTopics.length} 个话题`);
  return topicUrls;
}

function renderCorrections() {
  // 更正记录页（2026-10-07）：data/corrections.json -> /corrections/
  let list = [];
  try { list = JSON.parse(readFileSync(join(DATA_DIR, 'corrections.json'), 'utf8')); } catch (e) { list = []; }
  const body = list.length
    ? list.slice().reverse().map((c) =>
        `<div class="card"><div class="cdate">${esc(c.date || '')}</div>` +
        `<div class="citem">${esc(c.item || '')}</div>` +
        `<div class="cfix">更正：${esc(c.change || '')}</div>` +
        (c.reason ? `<div class="creason">原因：${esc(c.reason)}</div>` : '') +
        `</div>`
      ).join('\n')
    : `<div class="empty">暂无更正记录——我们会把每一次更正都记在这里。</div>`;
  const tpl = readFileSync(join(HERE, 'corrections-template.html'), 'utf8');
  const html = tpl
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SITE_URL}}', esc(SITE.url))
    .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
    .replaceAll('{{CORRECTIONS}}', body);
  mkdirSync(join(DIST, 'corrections'), { recursive: true });
  writeFileSync(join(DIST, 'corrections', 'index.html'), html);
  return [{ loc: SITE.url + '/corrections/', lastmod: TODAY }];
}

function renderSitemap(urls) {
  const uniq = [...new Map(urls.map((u) => [u.loc, u])).values()];
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    uniq
      .map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`)
      .join('\n') +
    `\n</urlset>\n`;
  writeFileSync(join(DIST, 'sitemap.xml'), xml);
  writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE.url}/sitemap.xml\n`);
  console.log(`sitemap 已生成：${uniq.length} 个 URL`);
}

// Telegram 内联搜索索引：全部期数（归档+RSS 内容）的标题+摘要+链接
function renderSearchIndex(dates) {
  const idx = [];
  for (const d of dates) {
    const ed = loadEdition(d);
    if (!ed) continue;
    for (const sec of ed.sections || []) {
      if (sec.hidden || sec.empty) continue;
      const dDate = sec.detailDate || d;
      const push = (entry, i) => {
        if (!entry || !entry.title) return;
        idx.push({
          t: entry.title,
          s: (entry.summary || entry.blurb || '').slice(0, 160),
          u: `${SITE.url}/detail/${dDate}/${sec.id}-${i}/`,
          d: dDate,
          sec: sec.name,
          hot: !!entry.hot,
        });
      };
      if (sec.headline) push(sec.headline, 0);
      (sec.items || []).forEach((it, i) => push(it, i + 1));
    }
  }
  writeFileSync(join(DIST, 'tg-search-index.json'), JSON.stringify(idx));
  console.log(`搜索索引已生成：${idx.length} 条`);
}


async function renderAll() {
  await preloadImgDims();
  const dates = listEditions();
  if (!dates.length) {
    console.log('没有可用期数，跳过渲染');
    return;
  }
  assertNoChainedDetailDate(dates);
  const allDates = [...dates].sort().reverse();
  const tpl = readFileSync(join(HERE, 'template.html'), 'utf8');
  const archiveDir = join(DIST, 'archive');
  mkdirSync(DIST, { recursive: true });
  // 静态资源：public/ → dist/（.b64 图片解码为 webp，.b64 字体解码为 woff2）
  const pubDir = join(ROOT, 'public');
  if (existsSync(pubDir)) cpSync(pubDir, DIST, { recursive: true });
  const distImgDir = join(DIST, 'images');
  if (existsSync(IMG_DIR)) {
    mkdirSync(distImgDir, { recursive: true });
    for (const f of readdirSync(IMG_DIR)) {
      if (!f.endsWith('.webp.b64')) continue;
      const webpName = f.slice(0, -4);
      try {
        const buf = Buffer.from(readFileSync(join(IMG_DIR, f), 'utf8'), 'base64');
        // 简单校验：webp 魔数 RIFF....WEBP
        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) {
          writeFileSync(join(distImgDir, webpName), buf);
        }
      } catch {}
    }
  }
  // 自托管字体：public/fonts/*.woff2.b64 → dist/fonts/*.woff2（WOFF2 魔数 wOF2）
  const fontDir = join(ROOT, 'public', 'fonts');
  if (existsSync(fontDir)) {
    mkdirSync(join(DIST, 'fonts'), { recursive: true });
    for (const f of readdirSync(fontDir)) {
      if (!f.endsWith('.woff2.b64')) continue;
      try {
        const buf = Buffer.from(readFileSync(join(fontDir, f), 'utf8'), 'base64');
        if (buf[0] === 0x77 && buf[1] === 0x4f && buf[2] === 0x46 && buf[3] === 0x32) {
          writeFileSync(join(DIST, 'fonts', f.slice(0, -4)), buf);
        }
      } catch {}
    }
  }
  const latest = dates[dates.length - 1];
  const sitemapUrls = [
    { loc: SITE.url + '/', lastmod: latest },
    { loc: SITE.url + '/archive/', lastmod: latest },
    { loc: SITE.url + '/feed.xml', lastmod: latest },
  ];
  for (const d of dates) {
    const ed = loadEdition(d);
    if (!ed) continue;
    mkdirSync(join(archiveDir, d), { recursive: true });
    // 归档页 canonical 指向自身，避免搜索引擎合并到首页
    const archHtml = renderPage(tpl, ed, allDates, `${SITE.url}/archive/${d}/`, false);
    writeFileSync(join(archiveDir, d, 'index.html'), archHtml);
    if (d === latest) {
      const homeHtml = renderPage(tpl, ed, allDates, SITE.url + '/', FEATURES.telegram.enabled);
      writeFileSync(join(DIST, 'index.html'), homeHtml);
    }
    sitemapUrls.push({ loc: `${SITE.url}/archive/${d}/`, lastmod: d });
  }
  renderArchiveIndex(allDates);
  const detailUrls = renderDetailPages(dates);
  const latestEd = loadEdition(latest);
  if (latestEd) renderFeedXml(latestEd);
  // 关于页
  const aboutTpl = readFileSync(join(HERE, 'about-template.html'), 'utf8');
  const aboutHtml = aboutTpl
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SITE_URL}}', esc(SITE.url))
    .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
    .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer))
    .replaceAll('{{CONTACT_EMAIL}}', esc(SITE.contactEmail || ''))
    .replaceAll('{{TG_CHANNEL_LINE}}', (FEATURES.telegram.enabled && FEATURES.telegram.channel)
      ? `<li>Telegram 频道：<a href="https://t.me/${esc(FEATURES.telegram.channel)}" target="_blank" rel="noopener">@${esc(FEATURES.telegram.channel)}</a>（每日头条推送）</li>` : '');
  mkdirSync(join(DIST, 'about'), { recursive: true });
  writeFileSync(join(DIST, 'about', 'index.html'), aboutHtml);
  sitemapUrls.push({ loc: SITE.url + '/about/', lastmod: latest });
  const topicUrls = renderTopicPages(dates);
  const correctionUrls = renderCorrections();
  renderSitemap([...sitemapUrls, ...detailUrls, ...topicUrls, ...correctionUrls]);
  renderSearchIndex(allDates);
  console.log(`渲染完成：共 ${dates.length} 期，首页 = ${latest}`);
}

async function main() {
  if (args['fetch-only']) {
    await fetchCandidates();
    return;
  }
  if (args['render-only']) {
    await renderAll();
    return;
  }
  // 图片管线不依赖 LLM，优先处理
  if (args.images) {
    await processEditionImages(TODAY);
    return;
  }
  // 无 LLM key（如 Cloudflare Pages 环境）：只渲染已推送的 edition，不抓取不编辑
  if (!process.env.LLM_API_KEY) {
    console.log('未检测到 LLM_API_KEY，仅渲染已有版本');
    await renderAll();
    return;
  }
  // 完整模式：抓取 → LLM → 渲染（供 GitHub Actions 独立运行，备用）
  console.log(`Newsforge 构建开始，日期 ${TODAY}${SKIP_LLM ? '（跳过 LLM）' : ''}`);
  const dates = listEditions().filter((d) => d < TODAY);
  const prevDate = dates[dates.length - 1];
  const prev = prevDate ? loadEdition(prevDate) : null;
  const prevSections = Object.fromEntries((prev?.sections || []).map((s) => [s.id, s]));

  const sections = [];
  for (const sec of SECTIONS) {
    sections.push(await buildSection(sec, prevSections[sec.id]));
  }
  const edition = { date: TODAY, site: SITE.name, sections };

  mkdirSync(EDITIONS_DIR, { recursive: true });
  writeFileSync(join(EDITIONS_DIR, `${TODAY}.json`), JSON.stringify(edition, null, 2));
  await renderAll();
  console.log(`构建完成：${TODAY}，${sections.length} 个板块`);
}

main().catch((e) => {
  console.error('构建失败:', e);
  process.exit(1);
});
