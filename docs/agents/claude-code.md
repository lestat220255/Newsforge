# 用 Claude Code 初始化 Newsforge（BYOK 模式）

> 初始化契约只有一份：`playbooks/onboarding.md`。本文件只讲 Claude Code 的装法、登录和注意事项，不含问题集。
> 本文件未能在本项目环境逐条实测，命令细节以 Anthropic 官方文档为准。

## 安装

```bash
npm install -g @anthropic-ai/claude-code
claude --version   # 应能打印版本号
```

需要 Node.js 18+（以官方文档为准）。

## 登录：订阅或 API key，二选一

- **订阅登录**（Claude Pro/Max 等）：运行 `claude` 后按提示在浏览器里登录你的 Claude 账号。
- **API key**：从 console.anthropic.com 创建 API key，然后在终端里：

```bash
export ANTHROPIC_API_KEY=<你的 key>
```

key 只放在你自己的终端环境里，不要写进仓库任何文件。

## 工作目录

先把你用 Newsforge 模板建好的仓库 clone 到本机，然后在**仓库根目录**启动 Claude Code——playbook、模板文件都在这个目录里，它必须能读到：

```bash
cd <你的仓库目录>
claude
```

**初始化必须用交互会话**：它是多轮对话（逐组问你问题、等你选），不要用 `claude -p` 这类非交互打印模式跑初始化。

## 启动指令

进入交互会话后，把 `playbooks/onboarding.md` 第 1 节的启动指令原样粘贴给它（记得先把仓库地址换成你的）。之后它会按契约逐组提问，你逐组回答即可。

## 交互审批注意事项

- 初始化要写文件、跑 `npm`/`git` 命令，Claude Code 默认会在执行命令和修改文件前请求你确认——逐个看清再批，这是正常流程。
- **不要**用 `--dangerously-skip-permissions` 跑初始化：它跳过全部确认，而初始化本来就需要你在场逐组做选择题，跳过审批没有意义，只增加风险。
- 如果它问你要不要把某个目录加入信任/允许列表，只允许你这个仓库目录，不要给整盘或家目录的宽泛权限。

## 已知差异

- Claude Code 的确认弹窗分"编辑文件"和"执行命令"两类，初始化中两类都会频繁出现，属正常节奏。
- 推送 GitHub 时如需 PAT，按 playbook 引用的 `docs/PUSH-MODES.md` 办：token 存 `~/.config/newsforge/`，不进 git。
- 每日运行不由本 CLI 常驻承担：初始化的 Q9-2 会把三条路摆给你选——GitHub Actions 自动日更（`docs/ACTIONS.md`）、换到能建定时任务的宿主、本机手动跑（完整命令序列见 `docs/SETUP.md` 第 3 节）。
