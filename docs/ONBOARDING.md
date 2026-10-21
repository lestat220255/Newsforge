# Newsforge 安装入口：先选模式

> 初始化的问题集、步骤顺序、产出物和完成判据只有一份，在 **`playbooks/onboarding.md`**（宿主无关契约）。
> 本文件只负责帮你选模式、把你送到正确的启动方式，不保留第二份剧本。

## 两种初始化模式

| | A. Muse 对话（零 API 成本） | B. 终端 Agent CLI（BYOK） |
|---|---|---|
| 用什么 | Muse App 里的 AI 助手 | 你在终端里打开的 Claude Code / Codex / Gemini CLI |
| 花钱吗 | 不调用付费 API，用你已有的 Muse 订阅 | 用你自己的 API key（或 CLI 的订阅登录）；初始化是一次性会话，token 量很小，成本极低 |
| 谁提问 | AI 助手在对话里逐组问 | CLI 在终端里逐组问，同样是真对话式 |
| 适合谁 | 已经在用 Muse 的人 | 没有 Muse、手边有任一家 agent CLI 或 API key 的人 |
| 每日运行 | 可由同一宿主建定时任务自动跑 | 初始化与首期上线不受影响；每日自动运行需要常驻宿主或后续托管方案，见 playbook 的宿主差异说明 |

两种模式执行的是**同一份** playbook：问题集、产出物、完成判据完全一致，不因模式不同而删减。

## 模式 A：Muse

把仓库建好后，新开一个对话，把启动指令发给 AI 助手（启动指令原文在 `playbooks/onboarding.md` 第 1 节），它会读契约并按顺序带你走。README 的「完整搭建流程」里有可直接复制的话术。

## 模式 B：终端 Agent CLI

先按你用的 CLI 看对应的适配说明，再在仓库根目录打开它、粘贴同一句启动指令：

- Claude Code → `docs/agents/claude-code.md`
- Codex → `docs/agents/codex.md`
- Gemini CLI → `docs/agents/gemini-cli.md`

## 给执行者（Agent）的话

无论你是哪种宿主：先完整读 `playbooks/onboarding.md`，再从它的 S0 开始严格按顺序执行。问题集只在那份文件里，本文件和各 CLI 适配说明里都没有第二份，不要凭记忆提问。
