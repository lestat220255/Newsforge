// Newsforge 构建管线 — lib/images.js：头条配图（og:image 抓取 → 本地 WebP → b64 进 git）
// 依赖 utils；被 render / run 调用。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { fetchText, isSafeUrl, ROOT, DATA_DIR, EDITIONS_DIR } from './utils.js';

const IMG_DIMS = {};
// R2 图片宽高边车（data/image-dims.json，key 为完整公网 URL）：R2 图片无本地文件，构建环境可能没有 public/images
function loadDimsSidecar() {
  try {
    const side = JSON.parse(readFileSync(join(DATA_DIR, 'image-dims.json'), 'utf8'));
    for (const [k, v] of Object.entries(side)) if (v && v.w && v.h) IMG_DIMS[k] = v;
  } catch {}
}
async function preloadImgDims() {
  loadDimsSidecar(); // 边车必读：R2 模式下构建环境可能根本没有 public/images
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

export {
  processEditionImages, pruneOldFiles, preloadImgDims, loadDimsSidecar, imgWH, fetchOgImage, downloadAndProcess,
  IMG_DIR,
};
