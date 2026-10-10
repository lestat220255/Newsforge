# Newsforge

<p align="center">
  <img src="public/logo.svg" width="96" alt="Newsforge logo">
</p>

用 AI 对话造一个**属于你自己的每日新闻站**。纯静态、全免费、零运维。

每天早晨，你的 AI 助手自动抓取你关心的信源、写成摘要，部署到 Cloudflare Pages 上。你起床时，网站已经更新好了。

## 它是什么

Newsforge 不是一个现成的新闻网站，而是一个**建站模板**：你告诉 AI 你想看什么（科技、开源、球鞋、园艺……任何领域），它帮你把网站搭起来、把定时任务建好。之后每天自动更新，你什么都不用管。

## 花多少钱

**零。** Cloudflare Pages 免费托管，不绑定域名的话直接用 `*.pages.dev` 子域名。唯一的成本是你自己的 AI 订阅（本来就有）——站内所有 AI 工作都由你的 AI 助手完成，不调用任何付费 API。

## 开始之前：你需要什么

1. 一个 **GitHub 账号**（存放网站代码）
2. 一个 **Cloudflare 账号**（免费，托管网站）
3. 一个 **Muse**（或者其他支持文件操作、定时任务、GitHub 推送的 AI 助手）——它负责和你对话、搭建网站、每天自动更新

## 一键开始

1. 点右上角 **Use this template**，建一个你自己的仓库（这步只能你亲手做）
2. 把 `docs/ONBOARDING.md` 这个文件丢给你的 Muse，对它说"按这个帮我建站"
3. 跟着它的提问走：网站叫什么、关心哪些领域、要不要 Telegram 通知、喜欢什么风格……全部是选择题
4. 去 Cloudflare 按它的指引连上仓库，网站就上线了

之后每天早晨，它会自动更新。你只需要在它汇报时点个头（或者设置成全自动）。

## 里面有什么

- `pipeline/` — 抓取 + 构建管线（RSS / 列表页 / GDELT / Mastodon，跨天去重，图片本地化）
- `modules/cyber/` — 一个示例模块，照着它就能写自己的模块
- `docs/` — 写给 AI 助手看的安装剧本和手册（`ONBOARDING.md` 是入口）
- `crons/` — 定时任务模板：每日构建、推送确认、信源健康检查

## 两条运行路径（先看懂这个）

**路径 A：AI 助手编辑（默认，零 API 成本）。**
每天的抓取由 `npm run fetch`（=`node pipeline/run.js --fetch-only`）完成，
编辑（选头条、写摘要点评）由你的 AI 助手按 `docs/SCRAPING.md` 和各模块 `editorial` 口径手工完成，
最后 `npm run render` 生成静态页面。这是模板设计的默认路径，不调用任何付费 API。

**路径 B：LLM API 自动编辑（备用）。**
设置 `LLM_API_KEY`（及可选 `LLM_BASE_URL` / `LLM_MODEL`，默认兼容 DeepSeek 接口）后，
`npm run build` 会走"抓取 → LLM 自动编辑 → 渲染"全自动流程，适合 GitHub Actions 无人值守运行。
这条路径要花你自己的 API 费用，默认关闭；`--skip-llm` 可强制跳过。

## 协议

MIT。拿去随便改，商用也行。
