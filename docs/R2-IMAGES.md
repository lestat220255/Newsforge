# 图片存 Cloudflare R2（给 AI Agent 看 + 给用户看）

Newsforge 的图片有两种策略，安装时由 Agent 问用户确认（**默认 R2**，`site.json` 里 `features.r2.enabled=true`；
未配好 R2 密钥前自动回退 b64 模式，不想用可关掉）：

| | A. b64 进 git | B. Cloudflare R2（**默认**） |
|---|---|---|
| 原理 | `.webp.b64` 文本进仓库，构建时解码 | 图片传 R2，edition 存公网 URL |
| 仓库体积 | ~1MB/天，3 年约 1GB（git 历史只增不减） | 几乎零增长（只推 edition JSON） |
| 运维 | 零额外操作 | 需建 bucket + token（一次） |
| 适合 | 试水、图片少的小站 | 正式站、长期运营 |

选 A（关掉 R2）什么都不用做。选 B 按下面走（默认即 B）。

---

## Agent 引导用户的完整流程（✋ 部分是用户亲手做）

### 第 1 步：建 bucket（✋ 用户，Cloudflare 控制台）

指引话术：

> 打开 [dash.cloudflare.com](https://dash.cloudflare.com) → 左侧 **R2** → **Create bucket**
> - 名字：`xxx-images`（换成你的站名，如 `news-images`）
> - 点 Create

### 第 2 步：公网访问（✋ 用户）

两个选项，**正式站推荐 B**：

- A. 冒烟测试用：进 bucket → **Settings** → **Public access** → 打开 **r2.dev** 公开访问（得到 `https://<id>.r2.dev`）
- B. 正式用：**Custom Domains** → **Connect Domain**，绑自己的图片域名（如 `img.example.com`，按提示加 DNS 记录）

### 第 3 步：建 API token（✋ 用户）

> R2 → **Manage R2 API Tokens** → **Create API token**
> - 名字：如 `newsforge-upload`
> - **Permissions**：选 **Object Read & Write**
> - **Specify bucket(s)**：只勾第 1 步建的 bucket
> - TTL：按需（可永久）
> - 点 Create → 页面会同时显示 **Access Key ID** 和 **Secret Access Key**
>
> ⚠️ **Secret 只显示这一次**，当时没复制就得重建 token。

### 第 4 步：用户把信息给你

需要 5 样（缺一不可）：

1. `endpoint`：S3 API 地址，如 `https://<account-id>.r2.cloudflarestorage.com`
   （token 页面或 bucket 的 S3 API 地址里找，**去掉末尾的 `/bucket名`**）
2. `bucket`：bucket 名
3. `publicBaseUrl`：公网地址，第 2 步的自定义域名（`https://img.example.com`）或 r2.dev 地址，**末尾不带 `/`**
4. `accessKeyId`
5. `secretAccessKey`

**安全说明**：

- 安全表单（credentials.request_api_access）**接不了 R2**——R2 的 S3 接口要密钥对做请求签名，系统明确 declined。只能用户直接发。
- 让用户直接发两个 key，你立刻写入 `~/.config/newsforge/r2.json`（600 权限），**绝不进 git、不进日志、不复述**。
- 拿到后先跑冒烟（第 6 步），确认 key 有效。

### 第 5 步：你配置（🤖）

```bash
cat > ~/.config/newsforge/r2.json <<'EOF'
{
  "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
  "bucket": "xxx-images",
  "publicBaseUrl": "https://img.example.com",
  "accessKeyId": "<用户给的>",
  "secretAccessKey": "<用户给的>"
}
EOF
chmod 600 ~/.config/newsforge/r2.json
```

然后 `site.json` 里开开关：

```json
"features": { "r2": { "enabled": true } }
```

### 第 6 步：冒烟测试（🤖，必须做）

```bash
node pipeline/lib/r2-images.js --backfill --dry-run   # 先预演，看 key 格式对不对
# 真实传一张：
node --input-type=module -e "
import('./pipeline/lib/r2-images.js').then(async m => {
  const cfg = m.loadR2Config();
  const client = m.makeR2Client(cfg);
  const url = await m.uploadBuffer(cfg, client, 'smoke-test.webp', Buffer.from('...'));
  console.log(url);
});"
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" <公网URL>
# 删掉测试文件，保持 bucket 干净
```

**铁律**：只验 HTTP 200 不够，**把图真正打开看一眼**（曾经有站标占位图被当成配图上线）。

### 第 7 步：lifecycle 决策（🤖 问用户，一次一问）

> ⚠️ 不要默认配 90 天自动删除！详情页是**永久归档 URL**，90 天后删图 = 老文章永久缺图。
>
> 推荐：**永久保留，不设 lifecycle 规则**。图片约 1MB/天，3 年约 1GB，R2 免费 10GB 额度内零成本。
>
> 如果用户已经在控制台加了 90 天规则，选永久保留的话提醒他去删掉（R2 → bucket → Management → Lifecycle rules）。

---

## 日常流程（R2 模式）

1. 定时构建照旧：下载 + 处理图片到本地，**不上传**，edition 里还是本地 `/images/` 路径
2. 用户确认"推送"后：
   ```bash
   node pipeline/run.js --upload-images --date=YYYY-MM-DD
   ```
   → 当期新图上传 R2（key = `YYYY-MM/文件名.webp`，按月分文件夹）
   → edition 图片字段改写为 R2 公网 URL → 自动重渲染
   → 有缺图则退出码 2，不继续发布
3. **逐个 curl 验证**图片 URL（HTTP 200 + `Content-Type: image/webp`），失败不推送
4. 只推 edition JSON + `data/image-dims.json`（**b64 不再进 git**，推送体积大减）
   - R2 模式下 `.gitignore` 建议加 `public/images/*.webp.b64`
5. 按原有流程验证首页/详情/RSS 上线

历史图片迁移：`node pipeline/lib/r2-images.js --backfill`（先 `--dry-run` 预演），
会把现有 b64 全部传 R2 并批量改写老 edition；传完确认无误再从 git 删除 b64。

## 宽高边车

`data/image-dims.json`（key 为完整公网 URL），上传时写入，随 edition 一起推送。
`preloadImgDims()` 先读边车（构建环境可能没有 `public/images/`），再读本地图片补充；
模板照常输出 `width`/`height` 防 CLS。

## 故障排查

- `EPROTO wrong version number`：运行环境走 HTTP(S) 代理而 AWS SDK 默认不读代理环境变量。
  `r2-images.js` 已内置 `proxy-agent` 处理；若代理做 TLS 中间人，启动时注入
  `NODE_EXTRA_CA_CERTS=<ca-bundle>`（Node 只在启动时读，代码里设置无效）。
- `socket hang up`：网络抖动，重跑即可（上传幂等，同 key 覆盖）。
- `[r2] 未启用`：检查 `site.json` 开关 + 配置文件是否存在、字段是否为占位值。
