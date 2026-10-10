// Newsforge 构建管线 — lib/utils.js：基础工具（路径 / 时区 / 抓取 / 字符串 / 时间）
// 被 fetchers / edit / images / render 共同依赖，不依赖它们（无循环引用）。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from '../site-config.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // pipeline/lib
const ROOT = join(HERE, '..', '..'); // 仓库根目录（lib 下了一层，多退一层）
const PIPELINE_DIR = join(ROOT, 'pipeline'); // 模板 HTML 等仍在 pipeline/ 下
const DIST = join(ROOT, 'dist');
const DATA_DIR = join(ROOT, 'data');
const EDITIONS_DIR = join(DATA_DIR, 'editions');

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

const UA = { 'User-Agent': 'NewsforgeBot/0.1' };
// 个别站点（如 CBC）直接拒绝机器人 UA，连接会被重置；这些域名改用浏览器 UA 抓取
const BROWSER_UA = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
const BROWSER_UA_HOSTS = new Set(['www.cbc.ca', 'www.nasdaq.com', 'www.anthropic.com']);

function headersFor(url) {
  try { if (BROWSER_UA_HOSTS.has(new URL(url).hostname)) return BROWSER_UA; } catch {}
  return UA;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    return decodeBody(buf, sniffCharset(buf, res.headers.get('content-type')));
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

function shortHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16).slice(0, 8);
}

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

function fmtDate(iso) {
  if (!iso) return '日期未知';
  const t = parseTime(iso);
  if (isNaN(t)) return '日期未知';
  return new Date(t + tzOffsetAt(t)).toISOString().slice(0, 10);
}

function fmtDateCN(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
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

function rfc2822(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

// RSS：只收录最新一期，头条+次条全进，链接指向本站详情页

function shortTitle(t, n = 18) {
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 关键词提取：英文专有名词 + 中文3-4字短语（更具区分度）+ 核心2字词

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

// 编码嗅探（2026-10-09）：部分中文站用 GBK，res.text() 默认 UTF-8 会乱码
// 从 fetchText 抽出，fetch-text.js 复用
function sniffCharset(buf, contentType) {
  const m = (contentType || '').match(/charset=([\w-]+)/i);
  if (m) return m[1].toLowerCase();
  const head = buf.subarray(0, 4096).toString('latin1');
  const m2 = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  return m2 ? m2[1].toLowerCase() : 'utf-8';
}
function decodeBody(buf, charset) {
  if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
    return new TextDecoder('gb18030').decode(buf);
  }
  return buf.toString('utf8');
}

export {
  HERE, ROOT, PIPELINE_DIR, DIST, DATA_DIR, EDITIONS_DIR,
  tzOffsetAt, sniffCharset, decodeBody,
  UA, BROWSER_UA, BROWSER_UA_HOSTS, headersFor, sleep, isSafeUrl, fetchText, toISO,
  pLimit, shortHash, esc, googleSearchUrl, cleanComment,
  parseTime, isFresh, isStale, fmtDate, fmtDateCN, dateBadge, detailUrl, entryDate,
  rfc2822, shortTitle,
};
