#!/usr/bin/env node
/**
 * 信源可用性探针（2026-10-08）
 *
 * 每天 04:00 运行（cron newsforge-source-probe），在 05:30 抓取之前完成，
 * 让自动移除当天生效。
 *
 * 机制：
 * - 串行探测全部信源（间隔 1s，避免并发挤爆出口），单个 20s 超时
 * - 判定：HTTP 2xx 且内容非空 → 可用；超时 → 未知（中性，不增不减）；
 *   HTTP 4xx/5xx、DNS 失败、连接拒绝 → 不可用
 * - data/source-health.json 记录 probeFails（独立计数器，不复用抓取的 fails）
 * - probeFails >= 3 → 移入 data/disabled-sources.json（不直接改 config.js，
 *   run.js 在抓取时按 sourceKey 过滤；恢复只需删对应条目）
 * - 安全阀：单次不可用源超过总数 30% → 视为本机网络故障，中止所有移除，
 *   改发警告邮件
 * - 有移除或触发安全阀时，发邮件到 site.json 里配置的 notifyEmail
 *
 * 用法: node pipeline/probe-sources.js [--limit N] [--section <id>] [--dry-run]
 *   --dry-run 只打印邮件内容，不真发
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SECTIONS, SUPPLEMENT_MASTODON, SITE } from './site-config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');
const HEALTH_PATH = join(DATA_DIR, 'source-health.json');
const DISABLED_PATH = join(DATA_DIR, 'disabled-sources.json');
const NOTIFY_EMAIL = (SITE.notifyEmail || '');

const BOT_UA = { 'User-Agent': 'NewsforgeBot/0.1' };
const BROWSER_UA = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};
const BROWSER_UA_HOSTS = new Set(['www.cbc.ca', 'www.nasdaq.com', 'www.anthropic.com']);
function headersFor(url) {
  try {
    if (BROWSER_UA_HOSTS.has(new URL(url).hostname)) return BROWSER_UA;
  } catch {}
  return BOT_UA;
}

const PROBE_TIMEOUT_MS = 20000;
const PROBE_INTERVAL_MS = 1000;
const REMOVE_AFTER_FAILS = 3;
const SAFETY_VALVE_RATIO = 0.3;

const args = process.argv.slice(2);
const limitN = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : null;
})();
const onlySection = (() => {
  const i = args.indexOf('--section');
  return i >= 0 ? args[i + 1] : null;
})();
const DRY_RUN = args.includes('--dry-run');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 源唯一 key：同名源加区分后缀（与 run.js 的 sourceKey 保持一致） */
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

/** 每个 type 的探测目标（与 run.js 各 fetch 函数实际 endpoint 对齐） */
function probeTarget(s) {
  switch (s.type) {
    case 'rss':
    case 'weblist':
      return { url: s.url, headers: headersFor(s.url) };
    case 'github':
      return { url: `https://api.github.com/repos/${s.repo}`, headers: BOT_UA };
    case 'github_trending':
      return { url: 'https://api.github.com/rate_limit', headers: BOT_UA };
    case 'huggingface':
      return { url: 'https://huggingface.co/api/models?limit=1', headers: BOT_UA };
    case 'v2ex':
      return { url: `https://www.v2ex.com/api/topics/show.json?node_name=${s.node}`, headers: BOT_UA };
    case 'reddit':
      return {
        url: `https://www.reddit.com/r/${s.sub}/new.json?limit=1`,
        headers: { ...BOT_UA, Accept: 'application/json' },
      };
    case 'govuk':
      return {
        url: `https://www.gov.uk/api/search.json?q=${encodeURIComponent(s.query)}&count=1`,
        headers: BOT_UA,
      };
    case 'gdelt':
      return { url: null, service: 'gdelt' }; // 服务级探测，只打一次
    case 'mastodon':
      return { url: `${s.instance}/api/v1/trends/links?limit=1`, headers: BOT_UA };
    default:
      return { url: null };
  }
}

const GDELT_PROBE_URL =
  'https://api.gdeltproject.org/api/v2/doc/doc?query=test&mode=artlist&maxrecords=1&format=json';

async function probeOnce(url, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) return { st: 'fail', err: `HTTP ${res.status}` };
    if (!text || !text.trim()) return { st: 'fail', err: '空内容' };
    return { st: 'ok' };
  } catch (e) {
    const m = e.message || String(e);
    if (/abort|timeout|timed out/i.test(m)) return { st: 'unknown', err: '超时' };
    if (/ENOTFOUND|EAI_AGAIN/.test(m)) return { st: 'fail', err: 'DNS 失败' };
    if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/.test(m)) return { st: 'fail', err: '连接拒绝' };
    return { st: 'fail', err: m.slice(0, 100) };
  } finally {
    clearTimeout(t);
  }
}

function loadJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function beijingDate() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

function sendEmail(subject, body) {
  if (DRY_RUN) {
    console.log('【DRY-RUN 邮件预览】');
    console.log('收件人:', NOTIFY_EMAIL);
    console.log('标题:', subject);
    console.log('正文:\n' + body);
    return;
  }
  try {
    execFileSync(
      'hatch_gws_cli',
      ['gmail', '+send', '--to', NOTIFY_EMAIL, '--subject', subject, '--body', body],
      { timeout: 120000 }
    );
    console.log(`[probe] 邮件已发送: ${subject}`);
  } catch (e) {
    console.error(`[probe] 邮件发送失败: ${e.message}`);
  }
}

async function main() {
  const today = beijingDate();
  // 收集待探测源
  const jobs = [];
  for (const sec of SECTIONS) {
    if (onlySection && sec.id !== onlySection) continue;
    for (const s of sec.sources) {
      jobs.push({
        key: sourceKey(sec.id, s),
        sectionId: sec.id,
        sourceName: s.name,
        source: s,
        ...probeTarget(s),
      });
    }
  }
  for (const m of SUPPLEMENT_MASTODON) {
    jobs.push({
      key: `supplement::${m.instance}`,
      sectionId: 'supplement',
      sourceName: `${m.name}(${m.instance})`,
      source: m,
      ...probeTarget({ type: 'mastodon', instance: m.instance }),
    });
  }
  const todo = limitN ? jobs.slice(0, limitN) : jobs;
  console.log(`[probe] 待探测 ${todo.length} 个源（共 ${jobs.length} 个），串行，间隔 ${PROBE_INTERVAL_MS}ms`);

  const health = loadJson(HEALTH_PATH, {});
  const disabled = loadJson(DISABLED_PATH, {});
  let gdeltResult = null; // GDELT 服务只探测一次
  const results = [];

  for (let i = 0; i < todo.length; i++) {
    const j = todo[i];
    let r;
    if (j.service === 'gdelt') {
      if (!gdeltResult) {
        gdeltResult = await probeOnce(GDELT_PROBE_URL, BOT_UA);
        console.log(
          `[probe] GDELT 服务探测: ${gdeltResult.st}${gdeltResult.err ? ' (' + gdeltResult.err + ')' : ''}`
        );
      }
      r = gdeltResult;
    } else if (!j.url) {
      r = { st: 'unknown', err: '无探测目标' };
    } else {
      r = await probeOnce(j.url, j.headers);
    }
    results.push({ ...j, ...r });
    const mark = r.st === 'ok' ? 'OK' : r.st === 'unknown' ? '??' : 'XX';
    console.log(`[probe] ${mark} ${j.key}${r.err ? ' - ' + r.err : ''}`);
    if (i < todo.length - 1) await sleep(PROBE_INTERVAL_MS);
  }

  // 更新健康计数器（probeFails 独立于抓取的 fails）
  const newlyDisabled = [];
  let failCount = 0;
  for (const r of results) {
    if (r.st === 'fail') failCount++;
    const h = health[r.key] || { fails: 0, probeFails: 0, status: 'ok' };
    if (r.st === 'ok') {
      h.probeFails = 0;
      h.lastProbe = today;
      h.lastProbeErr = null;
    } else if (r.st === 'unknown') {
      h.lastProbe = today; // 中性：不增不减
    } else {
      h.probeFails = (h.probeFails || 0) + 1;
      h.lastProbe = today;
      h.lastProbeErr = r.err;
    }
    health[r.key] = h;
  }

  // 安全阀：不可用超过 30% → 视为本机网络故障，中止所有移除
  const total = results.length;
  if (total > 0 && failCount / total > SAFETY_VALVE_RATIO) {
    const subject = `[Newsforge] 探针警告：疑似本机网络故障 (${today})`;
    const body = [
      `Newsforge 信源探针于 ${today} 检测到 ${failCount}/${total} 个源不可用（${Math.round((failCount / total) * 100)}%），超过 30% 安全阀。`,
      '',
      '判定为本机网络故障，本次中止所有自动移除，未修改任何源状态。',
      '',
      '不可用源列表：',
      ...results.filter((r) => r.st === 'fail').map((r) => `- ${r.key}: ${r.err}`),
      '',
      '请检查服务器网络/出口代理后，明日探针会自动重试。',
    ].join('\n');
    sendEmail(subject, body);
    console.log(`[probe] 安全阀触发：${failCount}/${total} 不可用，中止移除，已发警告邮件`);
    return;
  }

  // 自动移除：probeFails >= 3 且尚未禁用
  for (const r of results) {
    const h = health[r.key];
    if (r.st !== 'fail' || h.probeFails < REMOVE_AFTER_FAILS) continue;
    if (disabled[r.key]) continue; // 已禁用，不重复通知
    disabled[r.key] = {
      removedAt: today,
      reason: `连续 ${h.probeFails} 天探针不可用`,
      probeFails: h.probeFails,
      lastErr: r.err,
      sectionId: r.sectionId,
      sourceName: r.sourceName,
      source: r.source,
    };
    newlyDisabled.push({ ...r, probeFails: h.probeFails });
    console.log(`[probe] 自动移除: ${r.key}（连续 ${h.probeFails} 天不可用：${r.err}）`);
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(HEALTH_PATH, JSON.stringify(health, null, 2));
  writeFileSync(DISABLED_PATH, JSON.stringify(disabled, null, 2));

  // 邮件通知
  if (newlyDisabled.length) {
    const subject = `[Newsforge] 信源自动移除通知 (${today})`;
    const body = [
      `Newsforge 信源探针于 ${today} 自动移除了 ${newlyDisabled.length} 个信源（连续 ${REMOVE_AFTER_FAILS} 天不可用）：`,
      '',
      ...newlyDisabled.map(
        (r) => `- ${r.sourceName}（板块 ${r.sectionId}）：${r.err}，连续失败 ${r.probeFails} 天`
      ),
      '',
      '这些源已从每日抓取中跳过（配置备份在 data/disabled-sources.json）。',
      '恢复方法：确认源恢复可用后，删除 data/disabled-sources.json 中对应条目即可，次日抓取自动恢复。',
    ].join('\n');
    sendEmail(subject, body);
  }

  const okCount = results.filter((r) => r.st === 'ok').length;
  const unknownCount = results.filter((r) => r.st === 'unknown').length;
  console.log(
    `[probe] 完成：可用 ${okCount} / 未知 ${unknownCount} / 不可用 ${failCount}，新增移除 ${newlyDisabled.length} 个`
  );
}

main().catch((e) => {
  console.error('[probe] 运行异常:', e.message);
  process.exit(1);
});
