# GitHub Actions 日更（BYOK 模式）启用指南

> 这是 Newsforge 每日运行的**第二种宿主**：不用 Muse 常驻，
> 由 GitHub Actions 每天定时唤醒一个 agent CLI（Claude Code / Codex /
> Gemini CLI 之一），用**你自己的 API key** 按同一份
> `playbooks/daily.md` 契约完成编辑，QA 过了才提交上线。
> 编辑口径、产出物、完成判据与 Muse 模式完全一致，只换宿主。
> Muse 模式（零 API 成本）见 `docs/SETUP.md` 与 `crons/`。

## 适合谁

- 没有 Muse、或不想让一台机器常驻的人
- 已有 OpenAI / Anthropic / Google 任一家的 API key（或 Codex 可用的
  ChatGPT 订阅），愿意为每日编辑付按量费用的人

## 先分清：订阅与 API 是两个钱包

启用失败里最常见的一种，不是配置写错，而是钱付错了地方：

- **订阅**（ChatGPT Plus/Pro、Claude Pro/Max）是包月会员：额度只在
  产品内、以及用「订阅登录」的 CLI 里有效，按用量窗口（几小时 /
  每周）限流，不按 token 扣钱。
- **API key**（在 platform.openai.com / console.anthropic.com /
  Google AI Studio 创建的）是独立的预付钱包：按 token 扣费，
  新账户余额默认为 0。**订阅的钱不会流进 API 钱包。**

所以：明明买了 Plus，agent 步却报 `no credits remaining`——key
没错，是它背后的 API 钱包没充值。两条出路：给 API 钱包充值后继续
用 apikey 模式；或 Codex 后端改走订阅模式（变量
`NEWSFORGE_CODEX_AUTH=chatgpt` + 下面 Secrets 清单后的完整拿法），
吃订阅额度、零现金成本。本模板目前只有 Codex 后端支持订阅模式跑
Actions；Claude / Gemini 后端在 Actions 里只能用 API key。

## 启用步骤

**前置**：已按 `playbooks/onboarding.md` 完成初始化，站点能本地构建。

0. **让 site.json 进仓库**（最容易漏的一步）。模板默认把 site.json
   写进 .gitignore（本地模式不需要它进 git），但 Actions 的 runner 上
   没有你的本地文件，没 site.json 就没有站点配置。在本地执行：
   `git add -f site.json && git commit -m "chore: 提交站点配置（Actions 日更需要）" && git push`
   site.json 里只有站点信息、没有密钥，进仓库是安全的。
1. 仓库 **Settings → Secrets and variables → Actions**，先去
   **Variables** 页签加两个变量：启用守卫与后端选择（见下方清单）。
2. 去 **Secrets** 页签加所选后端的 API key（三家三选一）。
3. 按需补：开了 R2 图片（site.json 里 `features.r2.enabled`）就补 R2
   的变量与密钥；开了 Telegram 订阅就补 bot token 密钥。
4. 仓库 **Actions** 页 → 选 `daily（Actions 日更）` → **Run workflow**
   手动试跑一次，全程盯着它变绿（第一次最容易在配置校验步暴露缺项，
   报错都写明了缺什么）。
5. 试跑绿了就不用管了：每天 05:30（北京时间）自动跑。
   头几天建议每天瞄一眼 Actions 运行记录和首页，确认稳定再撒手。

**停用**：把启用守卫变量改成 `true` 以外的任何值（或删掉），
定时与外部触发会立刻全部跳过；也可以在 Actions 页直接 Disable workflow。

## Variables 清单（Settings → Secrets and variables → Actions → Variables）

| 名称 | 必填 | 说明 |
|---|---|---|
| `${{ vars.NEWSFORGE_DAILY_ENABLED }}` | **是** | 守卫开关：只有精确等于 `true` 才跑。不设 = 模板仓库自身惰性，永远跳过 |
| `${{ vars.NEWSFORGE_AGENT_BACKEND }}` | **是** | 后端三选一：`claude` / `codex` / `gemini`。不设时 workflow 默认按 `codex` 处理，但请显式写明 |
| `${{ vars.NEWSFORGE_CODEX_AUTH }}` | 否 | 仅 codex：`apikey`（默认，用 API key）或 `chatgpt`（用 ChatGPT 订阅登录态，需要下面的 auth 密钥） |
| `${{ vars.NEWSFORGE_CLAUDE_MODEL }}` | 否 | 仅 claude：模型名；不设用 CLI 默认 |
| `${{ vars.NEWSFORGE_CODEX_MODEL }}` | 否 | 仅 codex：模型名；不设用账号默认。`chatgpt` 认证时不要设（订阅账号拒绝 API 目录模型名） |
| `${{ vars.NEWSFORGE_GEMINI_MODEL }}` | 否 | 仅 gemini：模型名；不设用 CLI 默认 |
| `${{ vars.NEWSFORGE_AGENT_TIMEOUT }}` | 否 | agent 单次运行超时（秒），默认 3600。模块多、原文长时可调大（job 总上限 120 分钟） |
| `${{ vars.NEWSFORGE_R2_ENABLED }}` | 否 | `true` 表示本站用 R2 存图（与 site.json 的 `features.r2.enabled` 保持一致）。设了它，配置校验步会当场核对下面五个 R2 变量/密钥是否齐全，缺一个直接变红，不等 agent 跑到上传那步才发现 |
| `${{ vars.R2_ENDPOINT }}` | R2 时必填 | `https://<account-id>.r2.cloudflarestorage.com`，见 `docs/R2-IMAGES.md` |
| `${{ vars.R2_BUCKET }}` | R2 时必填 | bucket 名 |
| `${{ vars.R2_PUBLIC_BASE_URL }}` | R2 时必填 | 图片公网域名，如 `https://img.example.com` |

## Secrets 清单（Settings → Secrets and variables → Actions → Secrets）

| 名称 | 必填 | 去哪拿 |
|---|---|---|
| `${{ secrets.ANTHROPIC_API_KEY }}` | 后端三选一 | 后端选 claude 时必填。Anthropic Console → API Keys 创建 |
| `${{ secrets.OPENAI_API_KEY }}` | 后端三选一 | 后端选 codex 且认证为 apikey 时必填。OpenAI Platform → API keys 创建 |
| `${{ secrets.GEMINI_API_KEY }}` | 后端三选一 | 后端选 gemini 时必填。Google AI Studio → Get API key 创建 |
| `${{ secrets.CODEX_AUTH_JSON }}` | codex 订阅模式必填 | 本地装好 Codex 并 `codex login --device-auth` 登录后，把 `~/.codex/auth.json` 的**整个文件内容**粘进来。订阅登录态会过期，失效时重新登录、更新这个 secret（agent 步会报 401 提示） |
| `${{ secrets.R2_ACCESS_KEY_ID }}` | R2 时必填 | Cloudflare R2 的 API Token（Access Key ID），见 `docs/R2-IMAGES.md` |
| `${{ secrets.R2_SECRET_ACCESS_KEY }}` | R2 时必填 | 同上（Secret Access Key，只显示一次） |
| `${{ secrets.NEWSFORGE_TELEGRAM_BOT_TOKEN }}` | 否 | 开了 Telegram 订阅才需要：@BotFather 给的 bot token。与初始化时存本地的 token 是同一个。没配则跳过推送步，不影响上线 |

这些名称与 `.github/workflows/daily.yml` 里引用的集合由
`scripts/check-actions-contract.py` 逐一对账，改名必须两边同步。

### Codex 订阅模式：CODEX_AUTH_JSON 的完整拿法

后端选 codex 且不想给 API 钱包充值时用这条路（吃 ChatGPT 订阅
额度）。auth.json 就是你的 Codex 登录态文件，拿法一共四步：

1. 在**你自己的电脑**上装好 Codex 并用订阅登录：
   `npm install -g @openai/codex`，然后跑 `codex login --device-auth`
   （或 `codex login`），用 ChatGPT 账号完成授权；
   `codex login status` 应显示 Logged in using ChatGPT。
2. 登录态保存在本机 `~/.codex/auth.json`。打开它，把**整个文件
   内容原样**复制出来（不要改格式、不要只截其中一段）。
3. 回仓库 Settings → Secrets and variables → Actions：
   Secrets 里新建 `CODEX_AUTH_JSON`，值粘贴刚才的全部内容；
   Variables 里把 `NEWSFORGE_CODEX_AUTH` 设为 `chatgpt`，
   且**不要**设 `NEWSFORGE_CODEX_MODEL`（订阅账号拒绝 API 模型名）。
   这种模式下 `OPENAI_API_KEY` 可以不配。
4. Actions 页手动 Run workflow 试跑一次验证。订阅登录态会过期
   （refresh token 轮换失效），失效时 agent 步报 401——届时回本机
   重做第 1 步、把 secret 更新为新的 auth.json 内容即可，
   其他配置不用动。

安全须知：auth.json 等同你的 ChatGPT 登录凭证，只许进 Actions
secret，绝不进仓库、不发给任何人；不用了就删掉这个 secret，
并在本机 `codex logout`。

## 定时与抖动（如实披露）

- 默认定时是每天 **05:30（北京时间）**（cron 写 UTC `30 21 * * *`；
  站点时区不同请自行换算，cron 只能写 UTC）。
- **GitHub 的 schedule 不是闹钟**：官方明确说定时事件可能延迟，
  高负载时延迟可达小时级，极端情况下个别次会被丢弃；另外，
  **公开仓库连续 60 天没有任何活动，GitHub 会自动禁用它的
  schedule**（fork 仓库默认更是禁用状态）。这些是平台行为，
  不是本模板的策略，但你应该知道。
- 缓解办法（任选）：
  1. **提前量**：05:30 构建、站长起床才看的设计本来就留了余量，
     多数抖动不影响阅读时间；
  2. **外部准点触发**：用 cron-job.org 之类的免费定时服务，
     每天定点向仓库的 dispatches 接口发一个请求
     （`POST /repos/<owner>/<repo>/dispatches`，body 为
     `{"event_type": "newsforge-daily"}`，需要一个能访问该仓库的
     PAT 作 Authorization），workflow 的 repository_dispatch
     入口会接住它，准点程度由外部服务保证；
  3. **手动兜底**：发现没跑，Actions 页 Run workflow 点一下即可。

## 成本量级（估算，以账单为准）

每日编辑约 50 条：候选原文以全文进 agent 上下文，且 agent 是
多轮工具调用（每轮都重发上下文），单日输入量级约 **30 万–100 万
token**、输出约 **3 万–15 万 token**（模块数量、原文长度、
`features.aiAnalysis` 开关、失败重试都会放大）。按各家公开价目
粗算（2026 年量级，价格会变，**以账单为准**）：

- 小模型档（Flash / mini 类）：约 $0.2–1/天，**$5–30/月**
- 主力档（Sonnet / GPT-5 类）：约 $1.5–5/天，**$45–150/月**
- Codex 走 ChatGPT 订阅（auth 方式）：不按 token 计费，
  吃订阅的用量额度，美元成本为 0，但撞到订阅上限会失败

降本：先关 `features.aiAnalysis`（省约三到五成输出）、后端选
小模型档、模块别贪多。第一次启用建议手动试跑后立刻去
API 控制台看这次的真实用量，再决定用哪个档位常态化。

## 与 Muse cron 模式对照

| 维度 | Muse cron 模式 | GitHub Actions 模式（本页） |
|---|---|---|
| API 成本 | 0（用 Muse 订阅） | 按量付费，或吃 Codex 订阅额度 |
| 常驻机器 | 需要（Muse 宿主） | 不需要 |
| 定时精度 | 准时 | 有抖动（见上），可外部触发补 |
| 编辑契约 | `playbooks/daily.md` | 同一份 |
| 提交通道 | PAT 直推 / 手动确认（见 `docs/PUSH-MODES.md`） | workflow 用内置令牌自动提交 QA 通过的 edition |
| Telegram 推送 | 宿主跑 `pipeline/push-telegram.py` | workflow 在提交后代跑，失败只警告 |
| 故障感知 | 宿主直接向你汇报 | Actions 的失败邮件 + 本次运行的日志附件（保留 14 天） |

两种模式不要在同一个仓库同时启用（会一天出两份或互相覆盖）；
换模式时先停旧的（删 cron 任务 / 关守卫变量）再启新的。

## 故障排查

| 现象 | 多半是 | 处理 |
|---|---|---|
| Actions 里 workflow 显示 skipped、根本没进 job | 守卫变量没设 `true` | 按清单补 Variables，第一行 |
| 「配置校验」步变红 | 缺密钥，或 site.json 没提交 | 报错写明了缺哪项；site.json 按启用步骤第 0 步处理 |
| agent 步报 401 / 认证失败 | key 错或过期；或订阅模式的 auth 内容失效 | 换新 key 更新 secret；订阅模式重新 `codex login --device-auth` 并更新 auth secret |
| agent 步报 `no credits remaining` / 余额不足 | API 钱包没充值（订阅的钱不在这个钱包里，见本页「先分清：订阅与 API 是两个钱包」） | 给 API 钱包充值后重跑；或 Codex 后端改走订阅模式（`NEWSFORGE_CODEX_AUTH=chatgpt` + CODEX_AUTH_JSON） |
| agent 步超时（退出码 11） | 模块太多或原文太长，3600 秒没跑完 | 调大超时变量，或减模块/关 aiAnalysis；日志附件里能看到它干到哪一步 |
| 「QA 把关」步变红 | edition 没过检查（结构/字数/图片对应等） | 站点保持昨天的版本，不会发半成品；下载本次运行的 `daily-logs` 附件看 QA 原始报错，修配置或信源后手动重跑 |
| 提交步报「没有任何可提交变更」 | agent 没产出（抓取全灭或认证假过等） | 看 agent 日志附件；抓取问题先本地 `npm run probe` 看信源健康 |
| 定时没触发 | GitHub 抖动，或 60 天无活动被禁用 schedule | 手动 Run workflow 兜底；长期改用外部 repository_dispatch 触发 |
| 站上线了但 Telegram 没推 | bot token 没配、机器人不是频道管理员、或 `features.telegram.enabled` 没开 | 看 Telegram 那一步的 warning 输出逐项对 |
| push 成功但网站没更新 | Cloudflare Pages 构建问题（与宿主无关） | 看 Pages 后台的构建日志，排查口径同 `docs/SETUP.md` 故障排查节 |

## 安全须知

- 密钥只存 Actions secrets，绝不写进仓库任何文件；workflow 日志里
  GitHub 会自动打码已登记的 secret 值，但 agent 的输出日志附件
  不受这层保护——playbook 已明令 agent 不复述密钥，下载附件时
  仍请按敏感文件对待。
- workflow 的内置令牌只有 `contents: write` 一项权限，只够把
  edition 提交回本仓库。
- 外部触发用的 PAT 只给目标仓库的最小权限，用完可在 GitHub
  设置里随时吊销。
