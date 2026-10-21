# Newsforge 建站手册（给 AI Agent 看）

## 0. 初始化双模式（先读这节）

初始化的契约只有一份：**`playbooks/onboarding.md`**（宿主无关：问题集、产出物、步骤序列、完成判据都在里面）。`docs/ONBOARDING.md` 只是模式选择入口，不保留第二份剧本。

- **模式 A（Muse，零 API 成本）**：宿主提供对话、定时任务与推送通道，按 playbook + `crons/` 模板执行。
- **模式 B（终端 agent CLI，BYOK）**：用户在仓库根目录打开 Claude Code / Codex / Gemini CLI（API key 或订阅登录），粘贴 playbook 第 1 节的启动指令，执行同一份契约。各家 CLI 的装法、登录与审批注意事项在 `docs/agents/` 下，一家一份。
- 成本口径（对用户如实说）：初始化是一次性会话，token 量很小；持续 API 成本只在每日运行走 API 路径（README「两条运行路径」的路径 B）时才产生。每日运行的宿主有两种：Muse 定时任务（`crons/` 模板，见第 3 节）或 GitHub Actions（`.github/workflows/daily.yml`，agent CLI + API key，启用指南见 `docs/ACTIONS.md`）——二选一，不要在同一仓库同时开。没有常驻宿主时还有第三条：本机手动跑（见第 3 节），终端 CLI 用户先试水常用它。初始化时按 playbook 向用户确认选哪种宿主，不许在没落实宿主时假装建好定时任务。

## 1. 仓库结构

```
newsforge/
  site.json            # 安装时生成（从 site.json.example 复制填写），不进模板仓库
  site.json.example    # 配置模板
  pipeline/            # 抓取 + 构建管线
  modules/<id>/        # 模块目录，每个模块一个 module.json
  docs/                # 本手册 + 安装入口（ONBOARDING.md）+ 信源推荐 + 抓取策略 + agents/（各家 CLI 适配）+ ACTIONS.md（Actions 日更指南）
  playbooks/           # 宿主无关契约（onboarding.md 初始化、daily.md 每日运行，唯一真相）
  scripts/             # run-agent 执行器（Actions/本地跑 playbook）+ 契约测试
  .github/workflows/   # Actions 日更 workflow（BYOK 模式，变量守卫默认惰性）
  crons/               # 定时任务 prompt 模板（Muse 宿主模式）
  public/              # 静态资源与模板（构建时拷入 dist/；本身没有 index.html，不要当发布目录）
  dist/                # 构建输出（gitignore，Cloudflare Pages 的发布目录）
  data/editions/       # 每日 edition JSON（构建产物进 git，用于归档页）
```

## 2. Cloudflare Pages 构建配置（playbook S7 让用户照抄）

与 `playbooks/onboarding.md` S7、README 的口径字面一致（有契约测试对账，改一处必须三处同步）：

- 构建命令：`npm install && node pipeline/run.js --render-only && npx pagefind --site dist`
- 输出目录：`dist`（渲染产物，不进 git。**不要填 `public`**：`public/` 只是静态资源源目录，没有 index.html，填错了线上就是 404）
- 环境变量：`NODE_VERSION=20`
- 说明：Pages 构建只渲染仓库里已推送的 edition，不抓取、不编辑，不需要任何 API key。本地的 `npm run build` 是另一回事（本机全量构建命令），不要拿来填 Pages。

## 3. 每日流程

> 本节是 **Muse 宿主模式**的每日流程。Actions 宿主模式执行的是同一套
> 流程（同一份 `playbooks/daily.md` 契约），由 `.github/workflows/daily.yml`
> 一气跑完「抓取 → 编辑 → QA → 提交 → 推送」，启用与排查见 `docs/ACTIONS.md`。

1. **构建任务**（用户起床前 1.5h）：`node pipeline/run.js` → 抓取 → AI 编辑 → 生成 `data/editions/YYYY-MM-DD.json` → 本地渲染到 `dist/`。**只构建，不推送。**
2. **推送确认**（用户起床时间）：向用户汇报今日摘要（各模块新内容数、头条标题），问"推送吗"。
3. 用户确认后：按 `docs/PUSH-MODES.md` 的推送模式推送 edition JSON（全自动 = PAT `git push` 免审批；手动确认 = 确认后推送。R2 模式先 `node pipeline/run.js --upload-images` 传图改写再推 edition + `data/image-dims.json`；b64 模式图片 b64 随 edition 一起进 git）→ 等 3 分钟 → curl 首页确认 → curl `/feed.xml` 确认 RSS 同步 → 如启用 Telegram 则推送。
4. **发布后检查清单**：首页 HTTP 200、日期正确、RSS 条目数为当期数、图片真实打开看过（不能只验 HTTP 200）。

### 本机手动跑日更（没有常驻宿主时）

终端 CLI 初始化的用户，日更三选一：① 启用 GitHub Actions（`docs/ACTIONS.md`，推荐，不依赖本机开机）；② 换到能建定时任务的宿主（如 Muse，按 `crons/` 模板）；③ 本机手动跑。手动有两种姿势：

- **交互式**：在仓库根目录打开 agent CLI，把 `playbooks/daily.md` 交给它按 D0–D7 执行，然后由你（或它）接着跑下面的构建、QA、提交。
- **headless**：用 `scripts/run-agent` 一条命令完成编辑（与 Actions 里跑的是同一个执行器），完整序列如下（`DATE` 填站点时区的今日日期）：

```bash
DATE=YYYY-MM-DD   # 站点时区的今日日期
node pipeline/run.js --fetch-only --date=$DATE        # 1. 确定性抓取
python3 scripts/run-agent --playbook playbooks/daily.md --backend codex --date $DATE
                                                      # 2. AI 编辑（--backend 换成你用的那家；先确保该 CLI 已登录）
node pipeline/run.js --date=$DATE                     # 3. 构建渲染（环境无 LLM_API_KEY 时只渲染）
npm test                                              # 4. QA 把关，不过不许提交
git add data public/images && git commit -m "daily: $DATE edition" && git push
                                                      # 5. 提交（推送通道与审批见 docs/PUSH-MODES.md）
```

步骤顺序与 QA 把关口径与 Actions 模式完全一致（同一份 daily 契约），区别只是每步都要自己敲。本机**定时**自动跑（系统 cron / launchd / Windows 计划任务）目前**没有官方模板**：可以把上面 5 步写进系统定时器自备，但机器到点要开机、CLI 登录态过期要自己发现、出问题也没有失败通知——介意这些就用 Actions。

### 停用与切换宿主

- 停 Muse 日更：在 Muse 里删掉每日构建、每日推送、信源探针这三个定时任务即可；网站和仓库都保留，之后想恢复随时重建。
- 停 Actions 日更：见 `docs/ACTIONS.md` 的「停用」。
- 切换宿主：先停旧的再启新的。同一仓库不要同时开两种自动日更，会一天出两份或互相覆盖。

## 4. 图片策略

两种（安装时问用户，见 `playbooks/onboarding.md` 的 Q6；**默认 R2**，未配好密钥前自动回退 b64）：

**A. b64 进 git（零额外操作，可选）**

- 头条配图：RSS 自带图 → og:image → 下载本地 → 限宽 800px + WebP + 去 EXIF + 单张 < 90KB
- 图片以 `.webp.b64` 文本形式进 git（`public/images/*.webp` 二进制是 gitignore 的，Pages 构建时解码）
- **体积警告**：图片进 git 会让仓库持续变大。保留策略：图片 90 天、candidates 7 天，过期自动清理并在推送时删除对应的 b64
- **体积预算**：`npm test` 会检查 `public/images/*.b64` 总量，超 250MB 直接失败、挡住推送（正常 90 天滚动下约 160MB）
- **诚实说明**：90 天清理只管工作区，不管 git 历史——历史里的图片 blob 永远在。按每天约 1MB 估算，3 年左右历史增量约 1GB（GitHub 开始警告的量级）。到那时：要么迁到 R2（见下），要么重写 git 历史（`git filter-repo`，会打断所有克隆）。别等到 5GB 硬上限才动手

**B. Cloudflare R2（默认，正式站推荐，仓库几乎零增长）**

- 完整流程见 **docs/R2-IMAGES.md**（Agent 引导用户建 bucket → 拿密钥 → 冒烟测试 → lifecycle 决策）
- 日常：本地处理图片不上传 → 用户确认推送后 `node pipeline/run.js --upload-images --date=YYYY-MM-DD` 传 R2 → edition 改写为公网 URL → 逐个 curl 验证 → 只推 edition JSON + `data/image-dims.json`
- R2 按日分文件夹（`YYYY-MM/DD/文件名.webp`）；图片**永久保留不设 lifecycle**（详情页是永久归档）
- `.gitignore` 加 `public/images/*.webp.b64`

通用铁律（两种都适用）：

- og:image 可能是站标占位图（如含 logo/opg_/placeholder/default/avatar 字样）→ 跳过，无图比错图强
- 上线前把图真正打开看一眼（不能只验 HTTP 200）

## 5. 模块开发

复制 `modules/cyber/` 目录，改三处：

1. 目录名 → 新模块 id（**创建后不可改**，URL 里会用到）
2. `module.json` 的 `id` / `name` / `desc` / `position`
3. `sources` 数组：RSS 直填，weblist 按示例写选择器

`editorial` 字段（给 AI 编辑的口径，LLM 备用路径和 Agent 手工编辑都参考它）：

- `note`：一句话编辑口径（如"只收 48 小时内的实质性新闻，拒绝营销通稿"）
- `tone`：点评语气（如"冷静、信息密度高"）
- `headlineRule`（可选）：头条权重规则，会以最高优先级注入编辑 prompt。
  **只写中立的编辑标准**（如"突发安全漏洞优先"），不写任何政治立场、地域偏好。
  模板代码里不允许出现写死的板块立场——有立场需求的一律走这个字段，由站长自己负责。

然后跑 `npm run build` 验证新模块出现在首页。

## 6. 主题定制（CSS 变量）

主题变量的唯一来源是 `public/theme.css`（`:root` = 深色默认，`:root[data-theme="light"]` = 浅色），7 个模板共享。模板结构不要动，主题只通过 CSS 变量覆盖：

```css
:root {
  --bg: #141417;           /* 背景 */
  --surface: #1e1e23;      /* 卡片底 */
  --text: #f2f0ea;         /* 正文 */
  --muted: #9c978b;         /* 次要文字 */
  --accent: #e8a33d;        /* 强调色 */
  --border: #34343a;        /* 边框 */
  --border-strong: #62779a; /* 强边框（日历按钮等） */
  --ok: #4cc468;            /* 肯定色（多信源徽标文字） */
}
```

logo/favicon 换 `public/` 下的对应文件即可。深色模式模板已内置，跟随系统。

深色主题对比度目标（WCAG）：正文类 ≥7:1、其余文字 ≥4.5:1。改颜色时先算对比度再提交——`--muted2` / `--stale` 曾因不达标调亮过，别回退。

## 7. RSS / 归档 / 搜索

- RSS（`/feed.xml`）：最新一期全部条目，构建时自动生成
- 归档页（`/archive/`）：默认只展示最新一个月 + 侧栏年份大日历选月（桌面）/底部抽屉（移动）；每月的完整归档在 `/archive/YYYY-MM/` 月页（进 sitemap，构建时按 edition 数据自动生成）；日历周一起始，无归档日期置灰，选中日期高亮
- 沿用标注：某板块沿用前期内容时（`detailDate` ≠ 期号日期），首页/每日期页头条 kicker、归档页与话题页板块名后显示「沿用自 MM-DD」；详情页本身是原日期页面，不另标
- 搜索：pagefind 索引在 Pages 构建命令里单独生成（见第 2 节），`/` 快捷键聚焦
- sitemap.xml + robots.txt 构建时自动生成

## 8. 可选功能开关（site.json → features）

| 开关 | 说明 |
|---|---|
| `telegram.enabled` | Telegram 频道推送，默认关 |
| `correctionsPage` | `/corrections/` 更正页，默认开 |
| `qaChecks` | 推送前跑 `npm test`，默认开 |
| `geoHide` | 按地域隐藏敏感内容，需 Pages Functions，默认关 |
| `r2.enabled` | 图片存 Cloudflare R2，默认开（未配密钥自动回退 b64）；开启完整流程见 docs/R2-IMAGES.md |

## 9. 故障排查

先按环节分诊，别在错的文档里翻：

| 卡在哪一环 | 去哪查 |
|---|---|
| 初始化问答、产出物不对 | `playbooks/onboarding.md` 第 9 节（失败时如何求助） |
| 仓库权限、推送被拦、PAT | `docs/PUSH-MODES.md` |
| Pages 构建失败、上线后没更新 | 本节下面几条 + Pages 后台的构建日志 |
| Actions 日更没跑、QA 拦截、认证失败、定时没触发 | `docs/ACTIONS.md` 的故障排查表 |
| R2 上传失败、图片 URL 不对 | `docs/R2-IMAGES.md` 的故障排查 |
| 信源抓不到、被禁用 | 本节 + `npm run probe` 的健康报告 |

本节管的是构建与站点本身：

- 构建失败：先看 `node pipeline/run.js` 的报错，八成是某个源挂了 → `npm run probe` 看信源健康
- 线上没更新：查 Pages 的构建日志，确认 main 分支推送成功
- 图片裂了：b64 模式检查对应的 `.webp.b64` 是否推送到仓库（构建环境只有 b64，没有本地二进制）；R2 模式直接 curl 图片 URL 看 HTTP 状态和 Content-Type
- 排序错乱：检查时间字符串是否带时区，统一走 `parseTime()` 按用户时区解析
- 板块名空白：edition 的 section 缺 `name`/`desc`（渲染会用 `module.json` 兜底补齐，QA 缺 `name` 直接 FAIL；手工编辑 edition 时必须保留三字段）
