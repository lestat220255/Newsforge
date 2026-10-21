# Newsforge

<p align="center">
  <img src="public/logo.png" width="96" alt="Newsforge logo">
</p>

用 AI 对话造一个**属于你自己的每日新闻站**。纯静态、零代码、零成本、零运维。

每天早晨，AI 助手自动抓取你关心的信源、写成摘要，经你确认后部署到 Cloudflare Pages 上。

## 它是什么

Newsforge 不是一个现成的新闻网站，而是一个**建站模板**：你告诉 AI 你想看什么（科技、开源、球鞋、园艺……任何领域），它帮你把网站搭起来、把定时任务建好。之后每天自动更新，你什么都不用管。**全程不用写一行代码**——你的工作只是做选择题、点鼠标。

## 花多少钱

**零。** Cloudflare Pages 免费托管，不绑定域名的话直接用 `*.pages.dev` 子域名。唯一的成本是你自己的 AI 订阅（本来就有）——默认路径下，站内所有 AI 工作都由你的 AI 助手完成，不调用任何付费 API。（还有一条备用的全自动路径，需要自备 LLM API key，见下文「两条运行路径」。）

没有 Muse 也行：初始化可以改用终端里的 agent CLI（Claude Code / Codex / Gemini CLI）+ 你自己的 API key 完成，两种模式走同一份初始化契约（见 `docs/ONBOARDING.md`）。说清楚成本口径：**初始化是一次性会话，token 量很小、成本极低**；持续的 API 成本只在你选择让"每日运行"也走 API 时才产生（见「两条运行路径」的路径 B），用 Muse 托管每日运行则一直是零 API 成本。

## 仓库会长多大（以 10 个模块为例）

按每天约 64KB 的 edition 数据估算：

| 图片策略 | 仓库年增量 | 说明 |
|---|---|---|
| b64 进 git | 约 100MB/年 | edition 23MB + 图片 76MB；git 历史只增不减，3 年约 300MB |
| **R2（默认）** | 约 23MB/年 | 只有 edition 进仓库；图片存 R2（约 76MB/年，免费 10GB 额度内零成本） |

结论：R2 模式下仓库一年只长 20 多 MB，十年也就 200 多 MB，GitHub 的 1GB 警告线很远。不用为体积焦虑。

## 开始之前：你需要什么

1. 一个 **GitHub 账号**（存放网站代码）
2. 一个 **Cloudflare 账号**（免费，托管网站）
3. 一个 **AI 助手**：Muse（零 API 成本），或者终端 agent CLI（Claude Code / Codex / Gemini CLI，自备 API key 或用其订阅登录）——它负责和你对话、搭建网站。两种初始化模式怎么选、各自怎么开始，看 `docs/ONBOARDING.md`

## 完整搭建流程

全程约 40 分钟，其中约 30 分钟是和 AI 聊天做选择题，10 分钟亲手点鼠标。

### 第一阶段：准备（5 分钟）

你需要 3 样东西：

1. 一个 **GitHub 账号**（存放网站代码，公开/私有仓库都可以）
2. 一个 **Cloudflare 账号**（免费，到 [dash.cloudflare.com](https://dash.cloudflare.com) 注册）
3. 一个 **AI 助手**（推荐 Muse App；或终端 agent CLI：Claude Code / Codex / Gemini CLI，各家的装法与登录见 `docs/agents/`）——它负责和你对话、搭建网站

### 第二阶段：建仓库（2 分钟，亲手做）

1. 在本页面点右上角 **Use this template** → **Create a new repository**
2. 填仓库名（比如 `my-daily-news`），选 Public 或 Private，都行
3. 点 **Create repository**——这一步只能你亲手做，AI 建不了仓库

### 第二阶段半：把仓库地址给 AI（2 分钟，亲手做）

新开一个和 AI 的对话，**直接复制下面这段话发给它**（把 `XXX` 换成你的仓库地址）：

```
我想用 Newsforge 模板建一个每日更新的新闻网站，仓库已经建好了：
github.com/XXX/XXX(替换为实际仓库地址)

请先验证一下你有没有这个仓库的推送权限；如果是私有仓库，请引导我配置 PAT。
然后再请直接从仓库读取 docs/ONBOARDING.md，严格按剧本顺序帮我初始化。
```

AI 会验证推送权限。**私有仓库推荐当场配一个 PAT**（个人访问令牌：GitHub → Settings → Developer settings → Personal access tokens → 勾 `repo` 权限）——配好后推送全自动，不用每次点审批；不配的话每次推送你都要亲手点一次确认

> 用终端 agent CLI（BYOK 模式）的人：不用开新对话，在仓库根目录打开你的 CLI，粘贴的是同一句启动指令（原文在 `playbooks/onboarding.md` 第 1 节），各家 CLI 的具体操作看 `docs/agents/` 里对应的那份。两种模式的问题集和步骤完全一致。

发完上面那段话，下面的路线图瞄一眼有个概念就行——具体每一步 AI 都会带你走。

<details>
<summary>完整路线图（点击展开预览）</summary>

### 接下来 30 分钟：AI 带你走完建站

初始化契约 `playbooks/onboarding.md` 已经在你的仓库里（`docs/ONBOARDING.md` 是模式选择入口），AI 会自己去读。直接在第二阶段半的对话里继续，AI 会按顺序问你（每题先给推荐，你只管选；每题都有"以上都不合适，我来填写"）：
   - **网站基本信息**：先确认仓库地址和推送权限；再问叫什么名字？（先问内容方向再给建议）一句话介绍？联系邮箱（可跳过）？目标读者是谁（可多选）？你在哪个时区？有没有自己的域名？
   - **选模块**：AI 按你的意图推荐几个领域，你多选 + 可自定义；模板自带一个"赛博风向"示例模块照着抄
   - **定信源**：每个模块从哪抓？AI 会按领域推荐，你也可以指定（RSS、博客、论坛、官方文档都行）
   - **筛选要求**：有没有不想看的敏感话题？要不要 AI 点评 / AI 分析？加不加编辑原则（默认不加）？
   - **图片存哪**：默认 **Cloudflare R2**（推荐，仓库不膨胀）；也可以选 b64 进 git（零配置）。选 R2 的话 AI 会一步步教你：建 R2 bucket（`xxx-images`）→ 开公网访问（正式站推荐绑自己的图片域名）→ 建 API token（**Secret 只显示一次，当场复制发给 AI**，它会存进本机安全文件不进仓库）→ AI 冒烟测试传一张图、亲手打开确认
   - **Telegram 订阅**（可选，默认关）：要不要每天把头条推送到 Telegram 频道？要的话按指引找 @BotFather 建 bot
   - **主题风格**：喜欢浅色还是深色？（都支持，一键切换）配色、logo 按你的 taste 来，不套模板默认
   - **抓取策略**：默认每天抓一次，要不要调？
   - **纠错机制**：读者报错走什么渠道？
问完，AI 会在你的仓库里生成 `site.json`（站点配置）、`modules/`（你的模块）、主题样式。

然后 **AI 先抓一次真实内容**：按你的配置全量抓取 → 写摘要 → 本地生成第一版网站，截图给你确认。**没内容不部署**——如果抓不到，AI 会跟你一起调信源，直到有内容为止

### 上线：AI 会一步步教你弄 Cloudflare Pages（约 10 分钟）

前提是前面已有真实内容并经你确认——部署的是有内容的网站，不是空站。到时候 AI 会带着你点：登录 [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git 选中你的仓库，构建配置照抄（`npm install && node pipeline/run.js --render-only && npx pagefind --site dist`，输出目录 `dist`，环境变量 `NODE_VERSION=20`），点 Save and Deploy，等 1-2 分钟，`xxx.pages.dev` 就上线了 🎉 想绑自己的域名 AI 也会教你。

### 定时任务：AI 帮你配好

AI 会在对话里帮你建 3 个定时任务（模板在 `crons/` 里）：

| 任务 | 时间 | 做什么 |
|---|---|---|
| 每日构建 | 每天凌晨（你定，比如凌晨 5 点） | 抓取 → AI 编辑 → 生成今日版本 → 本地构建，**暂存不推送** |
| 每日推送 | 构建完成后 1.5 小时 | **默认全自动**：直接推送上线，然后向你汇报今日摘要；你也可以选手动确认模式 |
| 信源探针 | 每天凌晨 | 检查信源是否存活，连续 3 天挂掉的自动禁用并通知你 |

**推送方式二选一**（AI 会在建任务时问你，默认全自动）：

- **全自动（推荐）**：每天定时推送，无需你点任何东西。需要你亲手建一个 GitHub PAT（个人访问令牌，约 2 分钟：Settings → Developer settings → Personal access tokens → 勾 `repo` 权限），AI 拿它静默推送。
- **手动确认**：每天 AI 先汇报摘要，你回"推送"才上线。不用建 PAT，但每次推送你要在 App 里点一次审批。

为什么这样设计：AI 默认的 GitHub 授权每次推送都要你亲手点审批，**只有 PAT 能做到真正的无人值守**。不想每天被打扰就选全自动，配一次 PAT 一劳永逸。

### 建好之后：每天早晨看汇报就行

之后每天早晨，AI 会准时汇报："今日 X 个模块更新，Y 条新内容，头条是……"（全自动模式下网站已经更新完，这个汇报只是告诉你结果）。

随时想加新模块、换信源、调风格，直接跟 AI 说就行，改完它会本地验证再推送。

</details>

## 里面有什么

- `pipeline/` — 抓取 + 构建管线：`run.js` 只做调度，`lib/` 下分模块（`utils` 基础工具 / `fetchers` 信源抓取 / `edit` LLM 编辑 / `images` 图片管线 / `render` 静态渲染 / `r2-images` R2 图片上传）
- `modules/cyber/` — 一个示例模块，照着它就能写自己的模块
- `playbooks/` — 宿主无关契约（`onboarding.md` 初始化、`daily.md` 每日运行：问题集、步骤、产出物、完成判据的唯一真相，任何 AI 宿主都按它执行）
- `docs/` — 写给 AI 助手看的手册（`ONBOARDING.md` 是模式选择入口，`agents/` 是各家终端 CLI 的适配说明，`ACTIONS.md` 是 GitHub Actions 日更启用指南，`R2-IMAGES.md` 是图片存 R2 的完整指南）
- `crons/` — 定时任务模板：每日构建、推送确认、信源健康检查

## 两条运行路径（先看懂这个）

**路径 A：AI 助手编辑（默认，零 API 成本）。**
每天的抓取由 `npm run fetch`（=`node pipeline/run.js --fetch-only`）完成，
编辑（选头条、写摘要点评）由你的 AI 助手按 `docs/SCRAPING.md` 和各模块 `editorial` 口径手工完成，
最后 `npm run render` 生成静态页面。这是模板设计的默认路径，不调用任何付费 API。

**路径 B：GitHub Actions + agent CLI 自动编辑（BYOK）。**
不想让任何一台机器常驻时用这个：GitHub Actions 每天定时唤醒一个 agent CLI
（Claude Code / Codex / Gemini CLI 之一），拿你自己的 API key，按与路径 A
同一份每日契约（`playbooks/daily.md`）完成编辑，`npm test` QA 过了才提交、
Cloudflare Pages 自动上线。启用步骤、vars/secrets 清单、成本量级与
GitHub 定时抖动的如实披露都在 `docs/ACTIONS.md`。
这条路径花你自己的 API 费用（或 Codex 的 ChatGPT 订阅额度），默认关闭：
workflow 被仓库变量守卫，没显式启用就永远跳过，模板仓库自身不会空跑。

**本机手动（试水 / 兜底）。**
不想常驻、也不想开 Actions 时，可以在本机手动跑一次完整日更（抓取 →
按同一份 `playbooks/daily.md` 编辑 → 构建 → QA → 提交），完整命令
序列在 `docs/SETUP.md` 第 3 节。初始化模式与运行宿主的四种组合怎么
选，见 `docs/ONBOARDING.md` 的「初始化之后」一节。

> 代码里还留着一条更老的直连备用模式：给 `npm run build` 设置 `LLM_API_KEY`
>（及可选 `LLM_BASE_URL` / `LLM_MODEL`，默认兼容 DeepSeek 接口）后 run.js
> 会自己调 LLM API 编辑。它绕过了 agent 与 playbook 契约，只作备用保留，
> 新部署请用上面的 Actions 路径。

## 内容来源与署名

- 每条新闻都保留**原文链接和来源名称**，点击标题即跳转原文；摘要为 AI 改写、仅供参考，不能替代原文。
- 抓取时尽量做个有礼貌的访客：可识别的 `NewsforgeBot/0.1` UA（个别拒绝机器人 UA 的站点回退浏览器 UA）、请求超时与并发上限、每天只抓一次。信源是你在安装时亲手逐个挑选的——如果某个站点明确不欢迎抓取，请手动把它从信源列表里移除。
- 版权提醒：不同国家/地区对"新闻摘要"的合理使用规定不同，上线前请自行确认你的做法符合当地法律；如有来源方要求删除，请配合下架。

## 协议

MIT。拿去随便改，商用也行。
