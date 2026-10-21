# 用 Codex 初始化 Newsforge（BYOK 模式）

> 初始化契约只有一份：`playbooks/onboarding.md`。本文件只讲 Codex 这家 CLI 的装法、登录和注意事项，不含问题集。
> 本文件中的命令已按 Codex CLI 0.149.0 的 `--help` 输出核对；版本更新后如有出入，以官方文档为准。

## 安装

```bash
npm install -g @openai/codex
codex --version   # 应能打印版本号
```

（也可以用 OpenAI 官方提供的其他安装方式，以官方文档为准。）

## 登录：订阅或 API key，二选一

- **订阅登录**（ChatGPT Plus/Pro 等）：运行 `codex login`，按提示在浏览器里完成登录。查状态：`codex login status`。
- **API key**：从 platform.openai.com 的 API keys 页面创建，然后在终端里：

```bash
export OPENAI_API_KEY=<你的 key>
```

key 只放在你自己的终端环境里，不要写进仓库任何文件。

## 工作目录

先把你用 Newsforge 模板建好的仓库 clone 到本机，然后在**仓库根目录**启动 Codex——playbook、模板文件都在这个目录里，它必须能读到：

```bash
cd <你的仓库目录>
codex
```

不带子命令运行 `codex` 进入的是交互会话。**初始化必须用交互会话**：它是多轮对话（逐组问你问题、等你选），不要用 `codex exec` 这类非交互模式跑初始化。

## 启动指令

进入交互会话后，把 `playbooks/onboarding.md` 第 1 节的启动指令原样粘贴给它（记得先把仓库地址换成你的）。之后它会按契约逐组提问，你逐组回答即可。

## 交互审批注意事项

- 初始化要写文件、跑 `npm`/`git` 命令，Codex 会就命令执行向你请求批准——逐个看清再批，这是正常流程，说明它在按契约干活。
- Codex 有沙箱模式（`-s`：`read-only` / `workspace-write` / `danger-full-access`）。初始化需要在仓库内写文件，至少要 `workspace-write`；不要为了省事用 `danger-full-access`。
- **不要**用 `--dangerously-bypass-approvals-and-sandbox` 跑初始化：它会跳过全部确认（官方 help 里标注为 EXTREMELY DANGEROUS），而初始化本来就需要你在场逐组做选择题，跳过审批没有意义，只增加风险。

## 已知差异

- Codex 的审批粒度是"每条命令"，初始化中途会停下来等你批准命令，属正常节奏，不要以为卡住了。
- 推送 GitHub 时如需 PAT，按 playbook 引用的 `docs/PUSH-MODES.md` 办：token 存 `~/.config/newsforge/`，不进 git。
- 每日自动运行不在本模式范围内（Codex 不能常驻）：初始化完成时执行者会按 playbook 的 Q9-2 向你说明手动运行方式。
