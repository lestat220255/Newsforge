# Newsforge 建站手册（给 AI Agent 看）

## 1. 仓库结构

```
newsforge/
  site.json            # 安装时生成（从 site.json.example 复制填写），不进模板仓库
  site.json.example    # 配置模板
  pipeline/            # 抓取 + 构建管线
  modules/<id>/        # 模块目录，每个模块一个 module.json
  docs/                # 本手册 + 安装剧本 + 信源推荐 + 抓取策略
  crons/               # 定时任务 prompt 模板
  public/              # 构建输出（Cloudflare Pages 发布目录）
  data/editions/       # 每日 edition JSON（构建产物进 git，用于归档页）
```

## 2. Cloudflare Pages 构建配置（安装第 5 步让用户照抄）

- 构建命令：`npm run build`
- 输出目录：`public`
- Node 版本：18+
- 环境变量：无（零 API 成本，不需要任何 key）

## 3. 每日流程

1. **构建任务**（用户起床前 1.5h）：`node pipeline/run.js` → 抓取 → AI 编辑 → 生成 `data/editions/YYYY-MM-DD.json` → 本地渲染到 `public/`。**只构建，不推送。**
2. **推送确认**（用户起床时间）：向用户汇报今日摘要（各模块新内容数、头条标题），问"推送吗"。
3. 用户确认后：`push_files` 推送 edition JSON + 新增图片 b64 → 等 3 分钟 → curl 首页确认 → curl `/feed.xml` 确认 RSS 同步 → 如启用 Telegram 则推送。
4. **发布后检查清单**：首页 HTTP 200、日期正确、RSS 条目数为当期数、图片真实打开看过（不能只验 HTTP 200）。

## 4. 图片策略

- 头条配图：RSS 自带图 → og:image → 下载本地 → 限宽 800px + WebP + 去 EXIF + 单张 < 90KB
- 图片以 `.webp.b64` 文本形式进 git（`public/images/*.webp` 二进制是 gitignore 的，Pages 构建时解码）
- **体积警告**：图片进 git 会让仓库持续变大。保留策略：图片 90 天、candidates 7 天，过期自动清理并在推送时删除对应的 b64
- og:image 可能是站标占位图（如含 logo/opg_/placeholder/default/avatar 字样）→ 跳过，无图比错图强
- 上线前把图真正打开看一眼

## 5. 模块开发

复制 `modules/cyber/` 目录，改三处：

1. 目录名 → 新模块 id（**创建后不可改**，URL 里会用到）
2. `module.json` 的 `id` / `name` / `desc` / `position`
3. `sources` 数组：RSS 直填，weblist 按示例写选择器

然后跑 `npm run build` 验证新模块出现在首页。

## 6. 主题定制（CSS 变量）

模板结构不要动，主题只通过 CSS 变量覆盖。在 `pipeline/template.html` 的 `:root` 里改：

```css
:root {
  --brand: #2563eb;        /* 主色 */
  --brand-ink: #1e40af;    /* 主色深色 */
  --bg: #ffffff;           /* 背景 */
  --ink: #1a1a1a;          /* 正文 */
  --muted: #6b7280;        /* 次要文字 */
  --card: #f8fafc;         /* 卡片底 */
  --radius: 12px;          /* 圆角 */
}
```

logo/favicon 换 `public/` 下的对应文件即可。深色模式模板已内置，跟随系统。

## 7. RSS / 归档 / 搜索

- RSS（`/feed.xml`）：最新一期全部条目，构建时自动生成
- 归档页（`/archive/`）：按日期列出往期
- 搜索：pagefind，构建时生成索引，`/` 快捷键聚焦
- sitemap.xml + robots.txt 构建时自动生成

## 8. 可选功能开关（site.json → features）

| 开关 | 说明 |
|---|---|
| `telegram.enabled` | Telegram 频道推送，默认关 |
| `correctionsPage` | `/corrections/` 更正页，默认开 |
| `qaChecks` | 推送前跑 `npm test`，默认开 |
| `geoHide` | 按地域隐藏敏感内容，需 Pages Functions，默认关 |

## 9. 故障排查

- 构建失败：先看 `node pipeline/run.js` 的报错，八成是某个源挂了 → `npm run probe` 看信源健康
- 线上没更新：查 Pages 的构建日志，确认 main 分支推送成功
- 图片裂了：检查对应的 `.webp.b64` 是否推送到仓库（构建环境只有 b64，没有本地二进制）
- 排序错乱：检查时间字符串是否带时区，统一走 `parseTime()` 按用户时区解析
