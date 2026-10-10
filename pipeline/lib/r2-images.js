// Newsforge 图片 R2 迁移：处理好的 .webp 上传到 Cloudflare R2，
// edition 里存公网 URL，不再把 .webp.b64 提交进 git。
//
// 启用条件（安装时由 Agent 按 docs/R2-IMAGES.md 引导用户，二选一）：
//   1. site.json 里 features.r2.enabled = true
//   2. R2 配置文件存在（默认 ~/.config/newsforge/r2.json，600 权限；可用 R2_CONFIG 环境变量改路径）
// 配置内容：{ "endpoint", "bucket", "publicBaseUrl", "accessKeyId", "secretAccessKey" }
//   endpoint 如 https://<account-id>.r2.cloudflarestorage.com（S3 API 地址，去掉末尾的 /<bucket>）
//   publicBaseUrl 如 https://img.example.com（自定义域名，推荐）或 https://<id>.r2.dev
//
// 用法：
//   node pipeline/lib/r2-images.js --upload --date=YYYY-MM-DD   # 上传当期新图并改写 edition
//   node pipeline/lib/r2-images.js --backfill [--dry-run]      # 历史 b64 全量回填
// 或：node pipeline/run.js --upload-images --date=YYYY-MM-DD
//
// 约定：R2 按月分文件夹，key = YYYY-MM/<文件名>（如 2026-10/2026-10-01-tech-0.webp）
// 宽高边车 data/image-dims.json（key 为完整公网 URL），渲染时用。
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { ProxyAgent } from 'proxy-agent';
import sharp from 'sharp';
import { ROOT, DATA_DIR, EDITIONS_DIR } from './utils.js';
import { FEATURES } from '../site-config.js';

const IMG_DIR = join(ROOT, 'public', 'images');
const DIMS_PATH = join(DATA_DIR, 'image-dims.json');
const CONFIG_PATH = process.env.R2_CONFIG || join(homedir(), '.config', 'newsforge', 'r2.json');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const DRY = !!args['dry-run'];

// 是否启用 R2 图片：site.json 开关 + 配置文件存在，缺一不可
export function isR2Enabled() {
  if (!FEATURES?.r2?.enabled) return false;
  return existsSync(CONFIG_PATH);
}

export function r2Status() {
  if (!FEATURES?.r2?.enabled) return { enabled: false, reason: 'site.json features.r2.enabled 未开启' };
  if (!existsSync(CONFIG_PATH)) return { enabled: false, reason: `缺少 R2 配置 ${CONFIG_PATH}（见 docs/R2-IMAGES.md）` };
  return { enabled: true };
}

export function loadR2Config() {
  const st = r2Status();
  if (!st.enabled) throw new Error(st.reason);
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  for (const k of ['endpoint', 'bucket', 'publicBaseUrl', 'accessKeyId', 'secretAccessKey']) {
    if (!cfg[k] || /PLACEHOLDER/i.test(cfg[k])) throw new Error(`R2 配置缺字段或为占位值: ${k}`);
  }
  cfg.publicBaseUrl = cfg.publicBaseUrl.replace(/\/$/, '');
  return cfg;
}

export function makeR2Client(cfg) {
  const opts = {
    region: 'auto',
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  };
  // 代理环境（如某些 Agent 沙箱走 egress 代理）：AWS SDK 默认不读代理环境变量，必须显式配；
  // TLS 中间人证书靠启动时 NODE_EXTRA_CA_CERTS 注入（Node 只在启动时读，代码里设置无效）。
  if (process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY) {
    const agent = new ProxyAgent();
    opts.requestHandler = new NodeHttpHandler({ httpAgent: agent, httpsAgent: agent });
  }
  return new S3Client(opts);
}

export async function uploadBuffer(cfg, client, key, buf) {
  if (DRY) {
    console.log(`[dry-run] 上传 ${key} (${(buf.length / 1024).toFixed(0)}KB)`);
    return `${cfg.publicBaseUrl}/${key}`;
  }
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    Body: buf,
    ContentType: 'image/webp',
  }));
  return `${cfg.publicBaseUrl}/${key}`;
}

async function dimsOf(buf) {
  try {
    const meta = await sharp(buf).metadata();
    return meta.width && meta.height ? { w: meta.width, h: meta.height } : null;
  } catch {
    return null;
  }
}

export function loadDims() {
  try {
    return JSON.parse(readFileSync(DIMS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function saveDims(dims) {
  writeFileSync(DIMS_PATH, JSON.stringify(dims, null, 2));
}

// R2 按月分文件夹：key = YYYY-MM/<文件名>（R2 无真实目录，前缀即文件夹视图）
export function r2Key(dateStr, filename) {
  const m = /^\d{4}-\d{2}/.test(dateStr) ? dateStr.slice(0, 7) : 'misc';
  return `${m}/${filename}`;
}

// 遍历 edition 里所有图片字段（头条 + hot 次条），fn(img) 返回新值则替换
export function walkImages(ed, fn) {
  let changed = 0;
  for (const sec of ed.sections || []) {
    const h = sec.headline;
    if (h && h.image) {
      const nv = fn(h.image);
      if (nv && nv !== h.image) {
        h.image = nv;
        changed++;
      }
    }
    for (const it of sec.items || []) {
      if (it.image) {
        const nv = fn(it.image);
        if (nv && nv !== it.image) {
          it.image = nv;
          changed++;
        }
      }
    }
  }
  return changed;
}

// 上传当期所有本地 /images/ 图片到 R2，改写 edition 为公网 URL。幂等：已是 http 的跳过。
export async function uploadEditionImages(date) {
  const cfg = loadR2Config();
  const client = makeR2Client(cfg);
  const edPath = join(EDITIONS_DIR, `${date}.json`);
  if (!existsSync(edPath)) {
    console.log(`[r2] ${date} 无 edition 文件，跳过`);
    return { uploaded: [], missing: [] };
  }
  const ed = JSON.parse(readFileSync(edPath, 'utf8'));
  const dims = loadDims();
  const uploaded = [];
  const missing = [];
  const jobs = [];
  walkImages(ed, (img) => {
    if (!img.startsWith('/images/')) return undefined; // 已是 R2 链接或空
    jobs.push(img);
    return undefined;
  });
  for (const img of [...new Set(jobs)]) {
    const key = r2Key(date, basename(img)); // YYYY-MM/<date>-<sec>-<suffix>.webp
    const local = join(ROOT, img.replace(/^\//, ''));
    if (!existsSync(local)) {
      // 兼容 .b64 文本（历史期数）：解码后上传
      const b64 = local + '.b64';
      if (existsSync(b64)) {
        const buf = Buffer.from(readFileSync(b64, 'utf8'), 'base64');
        const url = await uploadBuffer(cfg, client, key, buf);
        const d = await dimsOf(buf);
        if (d) dims[url] = d;
        uploaded.push(url);
        console.log(`[r2] ${img} -> ${url}（来自 b64）`);
        continue;
      }
      missing.push(img);
      console.warn(`[r2] 本地文件缺失，跳过: ${img}`);
      continue;
    }
    const buf = readFileSync(local);
    const url = await uploadBuffer(cfg, client, key, buf);
    const d = await dimsOf(buf);
    if (d) dims[url] = d;
    uploaded.push(url);
    console.log(`[r2] ${img} -> ${url}`);
  }
  if (!DRY) {
    const byBase = {};
    for (const u of uploaded) byBase['/images/' + basename(u)] = u;
    const n = walkImages(ed, (img) => byBase[img]);
    writeFileSync(edPath, JSON.stringify(ed, null, 2));
    saveDims(dims);
    console.log(`[r2] ${date} 改写 ${n} 处图片链接，dims 边车已更新`);
  }
  return { uploaded, missing };
}

// 全量回填：把 public/images/*.webp.b64 全部传 R2，老期数 edition 批量改写。幂等（同 key 覆盖）。
export async function backfill() {
  const cfg = loadR2Config();
  const client = makeR2Client(cfg);
  if (!existsSync(IMG_DIR)) {
    console.log('[r2] public/images 不存在，无事可做');
    return { uploaded: 0, editions: 0 };
  }
  const files = readdirSync(IMG_DIR).filter((f) => f.endsWith('.webp.b64'));
  console.log(`[r2] 待回填 ${files.length} 个 b64`);
  const dims = loadDims();
  const urlByPath = {};
  let i = 0;
  for (const f of files) {
    const base = f.slice(0, -4); // 去掉 .b64
    const key = r2Key(base.slice(0, 10), base); // 文件名以 YYYY-MM-DD 开头 → 按月分文件夹
    const buf = Buffer.from(readFileSync(join(IMG_DIR, f), 'utf8'), 'base64');
    const url = await uploadBuffer(cfg, client, key, buf);
    const d = await dimsOf(buf);
    if (d) dims[url] = d;
    urlByPath['/images/' + base] = url;
    if (++i % 50 === 0) console.log(`[r2] 回填进度 ${i}/${files.length}`);
  }
  let edCount = 0;
  if (!DRY) {
    const eds = readdirSync(EDITIONS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    for (const f of eds) {
      const p = join(EDITIONS_DIR, f);
      const ed = JSON.parse(readFileSync(p, 'utf8'));
      let n = walkImages(ed, (img) => urlByPath[img]);
      // 旧版 R2 地址（根目录 key，无月份前缀）→ 迁移到按月文件夹
      n += walkImages(ed, (img) => {
        if (!img.startsWith(cfg.publicBaseUrl + '/')) return undefined;
        const rest = img.slice(cfg.publicBaseUrl.length + 1);
        if (/^\d{4}-\d{2}\//.test(rest)) return undefined; // 已是新格式
        const nv = `${cfg.publicBaseUrl}/${r2Key(rest.slice(0, 10), rest)}`;
        return nv === img ? undefined : nv;
      });
      if (n > 0) {
        writeFileSync(p, JSON.stringify(ed, null, 2));
        edCount++;
      }
    }
    // 清理边车里旧格式 R2 URL 的残留 key
    for (const k of Object.keys(dims)) {
      if (k.startsWith(cfg.publicBaseUrl + '/') && !/^\d{4}-\d{2}\//.test(k.slice(cfg.publicBaseUrl.length + 1))) {
        delete dims[k];
      }
    }
    saveDims(dims);
  }
  console.log(`[r2] 回填完成：${files.length} 张图片，${edCount} 期 edition 改写`);
  return { uploaded: files.length, editions: edCount };
}

async function main() {
  const st = r2Status();
  if (!st.enabled) {
    console.error(`[r2] 未启用：${st.reason}`);
    process.exit(1);
  }
  if (args.backfill) {
    await backfill();
    return;
  }
  if (args.upload) {
    const date = args.date || new Date().toISOString().slice(0, 10);
    const { uploaded, missing } = await uploadEditionImages(date);
    console.log(`[r2] 上传 ${uploaded.length} 张，缺失 ${missing.length} 张`);
    if (missing.length) process.exitCode = 2;
    return;
  }
  console.log('用法: node pipeline/lib/r2-images.js --upload --date=YYYY-MM-DD | --backfill [--dry-run]');
}

// 直接执行时才跑 CLI；被 run.js import 时不执行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[r2] 失败:', e.message);
    process.exit(1);
  });
}
