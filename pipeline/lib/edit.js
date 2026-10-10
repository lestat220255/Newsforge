// Newsforge 构建管线 — lib/edit.js：LLM 编辑（选头条/写摘要点评）+ edition 读写
// 依赖 utils / fetchers；被 render / run 调用。
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SITE, FEATURES, EDITORIAL } from '../site-config.js';
import { principlesPrompt } from './principles.js';
import { EDITIONS_DIR, parseTime, isFresh } from './utils.js';
import { collectSection } from './fetchers.js';

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
  const audienceRaw = SITE.audience;
  const audience = audienceRaw
    ? `（面向${Array.isArray(audienceRaw) ? audienceRaw.join('、') : audienceRaw}）`
    : '';
  const headlineRule = section.editorial?.headlineRule
    ? `   头条权重规则（模块自定义，最高优先级）：${section.editorial.headlineRule}\n`
    : '';
  const tone = section.editorial?.tone ||
    '游戏玩家口吻：像一位资深玩家在跟朋友聊新闻——直白、偶尔调侃、不端架子；但点到为止，不过火、不阴阳怪气、不引战、不预设立场';
  const wantComment = FEATURES.aiComment !== false;   // AI 点评（默认开）
  const wantAnalysis = FEATURES.aiAnalysis !== false; // AI 分析（默认开，更耗 token）
  const principlesRule = principlesPrompt(EDITORIAL.principles);
  const customRule = EDITORIAL.custom ? `   用户自定义口径：${EDITORIAL.custom}\n` : '';
  // 按功能开关裁剪 prompt（省 token：关掉的项不让 AI 生成）
  const commentLine = wantComment ? ' + 一句编辑点评' : '';
  const commentRule = wantComment
    ? '   点评要求：给出实质判断，不做因果跳跃（不许拿个案推普遍规律），不押韵、不凑数；没什么可说的就写事实延伸。\n'
    : '';
  const analysisRule = wantAnalysis
    ? '3. **每条新闻都必须写 AI 分析（analysis）和核心事实（keyFacts），这是必要逻辑，不许留空：**\n' +
      '   - 头条 analysis：2-3 段中文，讲透来龙去脉、对读者的实际影响、值得关注的后续；次条 analysis：1-2 段，点出关键看点即可。\n' +
      '   - keyFacts：3-6 条，每条 30 字以内，只写报道中的硬事实（数字/人名/时间/地点/动作），优先选摘要里没提到的。\n' +
      `   - 口吻：${tone}。\n` +
      '   - 铁律：分析里的每个事实断言必须能在摘要或 keyFacts 中找到对应；观点明确标注为看法，不许把判断写成事实。\n'
    : '';
  // JSON schema 按开关动态组装
  const hSchema = { title: "", url: "", source: "", publishedAt: "", summary: "" };
  if (wantComment) hSchema.comment = "";
  if (wantAnalysis) { hSchema.analysis = ""; hSchema.keyFacts = []; }
  Object.assign(hSchema, { hot: true, unverified: false, multi_source: false, is_update: false });
  const iSchema = { title: "", url: "", source: "", publishedAt: "", blurb: "" };
  if (wantAnalysis) { iSchema.analysis = ""; iSchema.keyFacts = []; }
  Object.assign(iSchema, { hot: true, unverified: false, multi_source: false, is_update: false });
  const schemaJson = JSON.stringify({ headline: hSchema, items: [iSchema], hidden: false });
  const prompt =
    `你是 Newsforge 资讯站${audience}的编辑。以下是「${section.name}」板块过去约 24 小时抓到的候选资讯。\n` +
    `请完成：\n` +
    `1. 选出 1 条头条 + 最多 5 条次条。标准：对读者最有用的"窗口 / 机会 / 重大变化"（板块定位：${section.desc}）。\n` +
    `   头条 48 小时规则：头条必须是 48 小时内发布的最新重要新闻；无够格头条则该板块隐藏（hidden:true）。\n` +
    `   信源要求：优先选择有多家媒体报道的新闻（至少两个独立信源）；实在只有一个信源也可收，但不要硬凑。\n   可信度权重（2026-10-07）：单信源且明确标注"未经证实/待确认"的新闻，可信度最低。头条不得选未证实新闻（无更优选项时宁可 hidden）；次条中未证实新闻排在已证实之后。JSON 里给每条加 "unverified": true/false。\n` +
    `   补充源降级：标注 [补充源] 的候选来自 GDELT 全网抓取或 Mastodon 趋势热榜，相关度噪音较大；主力源有够格条目时优先选主力源，补充源仅作备选。\n` +
    `   重要度：头条和次条都打 hot 标记（true=真正的热点才打，不要滥用）。\n` +
    headlineRule +
    (principlesRule ? principlesRule + '\n' : '') +
    customRule +
    `2. 标题译成简体中文；头条写 200 字以内中文摘要${commentLine}；次条写 15 字以内中文一句话摘要。\n` +
    `   摘要要求：不说空话套话（如"作为目前最主流的"）；必须包含一句话背景 + 这件事为什么重要。\n` +
    commentRule +
    `   行文要求：只写报道明确说了什么；不写"报道暗示""或意味着"这类 AI 推断腔，不确定的写"待确认"。\n` +
    analysisRule +
    `4. 只做公开资讯整理，绝不写任何操作教程。\n` +
    `5. 每条的 url 必须原样沿用候选中的链接，绝不编造。\n` +
    `只输出 JSON（无其他文字）：\n` +
    schemaJson + `\n` +
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
      analysis: '',
      keyFacts: [],
    },
    items: rest.map((it) => ({
      title: it.title,
      url: it.url,
      source: it.source,
      publishedAt: it.publishedAt,
      blurb: it.source,
      analysis: '',
      keyFacts: [],
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

async function buildSection(section, prevSection, { today, skipLlm = false, skipGdelt = false } = {}) {
  const candidates = await collectSection(section, { skipGdelt });
  // 跨期去重（2026-10-10）：上一期已发布的 URL 不得再次入选。
  // 根因：isFresh 的 36h 窗口大于 24h 构建周期，昨天的条目今天仍算"新鲜"，AI 会整版复读且不走沿用逻辑。
  const prevUrls = new Set();
  const normUrl = (u) => String(u || '').split(/[?#]/)[0].replace(/\/$/, '');
  if (prevSection) {
    if (prevSection.headline?.url) prevUrls.add(normUrl(prevSection.headline.url));
    for (const it of prevSection.items || []) if (it.url) prevUrls.add(normUrl(it.url));
  }
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
    picked = skipLlm ? fallbackPick(fresh) : await callLLM(section, fresh);
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
    updatedAt: today,
  };
}

// ---------------- 渲染 ----------------

export {
  callLLM, fallbackPick, listEditions, loadEdition, buildSection,
};
