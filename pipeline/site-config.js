// Newsforge 站点配置加载器
//
// 配置分两处（安装时由 Agent 对话式填写）：
//   1. site.json            — 站点名称、域名、meta、主题、功能开关（Telegram/纠错页/QA 等）
//                            没有 site.json 时回退读 site.json.example（首次渲染演示用）
//   2. modules/<id>/module.json — 每个模块独立目录：id（URL 用，创建后不可改）、name、
//                            desc（板块定位，一句话）、position（排序，数字越小越靠前）、
//                            sources（抓取源清单，写法见 modules/cyber/module.json 示例）
//
// 约定：SECTIONS 顺序 = 全站板块顺序（首页、导航、归档、RSS 都按此顺序）。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

const siteFile = existsSync(join(ROOT, 'site.json'))
  ? join(ROOT, 'site.json')
  : join(ROOT, 'site.json.example');

const raw = loadJson(siteFile);

export const SITE = {
  name: 'My Site',
  url: 'https://example.pages.dev',
  tagline: '',
  language: 'zh-CN',
  timezone: 'Asia/Shanghai',
  contactEmail: '',
  disclaimer: '',
  notifyEmail: '',
  ...raw.site,
};

// 功能开关（安装时逐项问用户）
export const FEATURES = {
  telegram: { enabled: false, channel: '' }, // 启用后填频道名（不带 @）
  correctionsPage: true,   // /corrections/ 更正页
  qaChecks: true,          // 推送前跑 npm test（qa-check.py）
  geoHide: false,          // 地域隐藏（需 Cloudflare Pages Function）
  ...raw.features,
};

// 模块：modules/<id>/module.json，按 position 排序
const modulesDir = join(ROOT, 'modules');
export const SECTIONS = existsSync(modulesDir)
  ? readdirSync(modulesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(modulesDir, d.name, 'module.json'))
      .filter((p) => existsSync(p))
      .map(loadJson)
      .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
  : [];

// Mastodon 趋势补充源（降级机制：主力源候选不足时才启用，见 docs/SCRAPING.md）
export const SUPPLEMENT_MASTODON = raw.supplement?.mastodon ?? [
  { name: 'mastodon.social', base: 'https://mastodon.social' },
  { name: 'fosstodon.org', base: 'https://fosstodon.org' },
];
