// QA-6 顺序口径：输出渲染口径的详情页顺序表，供 qa-check.py 第 6 组跨期检查使用。
// 详情页 URL 序号以渲染为准，即 loadEdition 重排后位置（未证实沉底、发布时间倒序），
// 不是 edition 文件原顺序。直接调渲染的 loadEdition，不在 Python 里复刻排序规则，
// 避免两份规则漂移（QA-6 修复，2026-10-30）。
// 用法：node pipeline/qa-render-order.js（在仓库根运行，qa-check.py 会自己调它）
// 输出：单行 JSON，{ "<date>": { "<sectionId>": [标题0(头条或 null), 标题1, ...] } }；
// 读不到的期数值为 null，调用方须硬拦，不得静默回落到文件顺序。
import { readdirSync } from 'node:fs';
import { EDITIONS_DIR } from './lib/utils.js';
import { loadEdition } from './lib/edit.js';

const out = {};
for (const f of readdirSync(EDITIONS_DIR).sort()) {
  if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
  const d = f.slice(0, 10);
  const ed = loadEdition(d);
  if (!ed) { out[d] = null; continue; }
  const secs = {};
  for (const sec of ed.sections || []) {
    const titles = [sec.headline ? (sec.headline.title ?? '') : null];
    for (const it of sec.items || []) titles.push(it ? (it.title ?? '') : null);
    secs[sec.id] = titles;
  }
  out[d] = secs;
}
console.log(JSON.stringify(out));
