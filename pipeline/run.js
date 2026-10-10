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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECTIONS, SITE } from './site-config.js';
import { tzOffsetAt, EDITIONS_DIR } from './lib/utils.js';
import { fetchCandidates } from './lib/fetchers.js';
import { buildSection, listEditions, loadEdition } from './lib/edit.js';
import { processEditionImages } from './lib/images.js';
import { renderAll } from './lib/render.js';

// 启动时校验时区名：拼错立刻警告，不要静默回退
try {
  new Intl.DateTimeFormat('en-US', { timeZone: SITE.timezone || 'Asia/Shanghai' });
} catch {
  console.warn(`[warn] site.json 的 timezone "${SITE.timezone}" 非法，已回退为 Asia/Shanghai。请检查拼写（IANA 时区名，如 America/New_York）。`);
  SITE.timezone = 'Asia/Shanghai';
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const SKIP_LLM = !!args['skip-llm'];
const SKIP_GDELT = !!args['skip-gdelt']; // GDELT 限流严重时跳过

const TODAY = args.date || new Date(Date.now() + tzOffsetAt(SITE.timezone, Date.now())).toISOString().slice(0, 10);

async function main() {
  if (args['fetch-only']) {
    const onlyIds = args.sections
      ? String(args.sections).split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    await fetchCandidates({ today: TODAY, onlyIds, skipGdelt: SKIP_GDELT });
    return;
  }
  if (args['render-only']) {
    await renderAll({ today: TODAY });
    return;
  }
  // 图片管线不依赖 LLM，优先处理
  if (args.images) {
    await processEditionImages(TODAY);
    return;
  }
  // R2 图片上传（用户确认推送后）：当期新图 → R2 → edition 改写为公网 URL → 重渲染
  // 缺图则退出码 2，不继续发布。用法见 docs/R2-IMAGES.md
  if (args['upload-images']) {
    const { uploadEditionImages, r2Status } = await import('./lib/r2-images.js');
    const st = r2Status();
    if (!st.enabled) {
      console.error(`[r2] 未启用：${st.reason}`);
      process.exit(1);
    }
    const { uploaded, missing, failed } = await uploadEditionImages(TODAY);
    if (missing.length) {
      console.error(`[r2] ${missing.length} 张图片缺失，不继续发布`);
      process.exit(2);
    }
    if (failed.length) {
      console.error(`[r2] ${failed.length} 张图片公网校验失败，不继续发布`);
      process.exit(2);
    }
    console.log(`[r2] 上传 ${uploaded.length} 张，重渲染中…`);
    await renderAll({ today: TODAY });
    return;
  }
  // 无 LLM key（如 Cloudflare Pages 环境）：只渲染已推送的 edition，不抓取不编辑
  if (!process.env.LLM_API_KEY) {
    console.log('未检测到 LLM_API_KEY，仅渲染已有版本');
    await renderAll({ today: TODAY });
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
    sections.push(await buildSection(sec, prevSections[sec.id], { today: TODAY, skipLlm: SKIP_LLM, skipGdelt: SKIP_GDELT }));
  }
  const edition = { date: TODAY, site: SITE.name, sections };

  mkdirSync(EDITIONS_DIR, { recursive: true });
  writeFileSync(join(EDITIONS_DIR, `${TODAY}.json`), JSON.stringify(edition, null, 2));
  await renderAll({ today: TODAY });
  console.log(`构建完成：${TODAY}，${sections.length} 个板块`);
}

main().catch((e) => {
  console.error('构建失败:', e);
  process.exit(1);
});
