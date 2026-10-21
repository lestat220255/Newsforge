# 用 Gemini CLI 初始化 Newsforge（BYOK 模式）

> 初始化契约只有一份：`playbooks/onboarding.md`。本文件只讲 Gemini CLI 的装法、登录和注意事项，不含问题集。
> 本文件未能在本项目环境逐条实测，命令细节以 Google 官方文档为准。

## 安装

```bash
npm install -g @google/gemini-cli
gemini --version   # 应能打印版本号
```

需要 Node.js 18+（以官方文档为准）。

## 登录：Google 账号或 API key，二选一

- **Google 账号登录**：运行 `gemini` 后按提示用 Google 账号登录（免费层有一定额度，初始化的一次性会话通常够用；额度规则以官方说明为准）。
- **API key**：从 Google AI Studio（aistudio.google.com）创建 API key，然后在终端里：

```bash
export GEMINI_API_KEY=<你的 key>
```

key 只放在你自己的终端环境里，不要写进仓库任何文件。

## 工作目录

先把你用 Newsforge 模板建好的仓库 clone 到本机，然后在**仓库根目录**启动 Gemini CLI——playbook、模板文件都在这个目录里，它必须能读到：

```bash
cd <你的仓库目录>
gemini
```

**初始化必须用交互会话**：它是多轮对话（逐组问你问题、等你选），不要用带 `-p` 的非交互模式跑初始化。

## 启动指令

进入交互会话后，把 `playbooks/onboarding.md` 第 1 节的启动指令原样粘贴给它（记得先把仓库地址换成你的）。之后它会按契约逐组提问，你逐组回答即可。

## 交互审批注意事项

- 初始化要写文件、跑 `npm`/`git` 命令，Gemini CLI 会在执行工具调用前请求你确认——逐个看清再批，这是正常流程。
- **不要**用跳过全部确认的模式（如 `--yolo`）跑初始化：初始化本来就需要你在场逐组做选择题，跳过审批没有意义，只增加风险。（该参数名以官方文档为准。）
- 注意它的上下文包含文件范围设置：确保仓库根目录在允许范围内，它才读得到 `playbooks/` 和 `docs/`。

## 已知差异

- 各家 CLI 里 Gemini CLI 的免费登录额度对"只做一次初始化"的用户最友好，但额度政策会变，以官方为准。
- 推送 GitHub 时如需 PAT，按 playbook 引用的 `docs/PUSH-MODES.md` 办：token 存 `~/.config/newsforge/`，不进 git。
- 每日运行不由本 CLI 常驻承担：初始化的 Q9-2 会把三条路摆给你选——GitHub Actions 自动日更（`docs/ACTIONS.md`）、换到能建定时任务的宿主、本机手动跑（完整命令序列见 `docs/SETUP.md` 第 3 节）。
