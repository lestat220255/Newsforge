# 变更提案：Actions 日更拆 edit/publish 两 job、收紧密钥权限、加部署确认

> 提案来源：2026-11-03 用户指出的两项 P0，经逐项核查代码属实后立项。
> 状态：已批复（用户 2026-11-04 认可方案方向无调整，审阅本地实施后说“推”）。

## 标题

Actions 日更拆 edit/publish 两 job、收紧密钥权限、加部署确认。

## 为什么

- P0-1：编辑 agent 与发布流程同 job、同写权限、同凭证，agent 进程可见 R2 密钥与全部模型 key，禁 git push 只是提示词；QA 与 agent 共用工作区，门禁不独立。
- P0-2：workflow 在 git push 后直接发 Telegram，推送成功被当成已上线；宪法 §五要求的推送后服务器端验证（首页/feed/配图/通知）一步都没做，Pages 构建失败完全静默。

## 改什么

- daily.yml 拆成 edit（只读、只编辑、只产 artifact）与 publish（干净 checkout、确定性发布）两个 job，artifact 按日期路径白名单交接。
- edit job 权限降为 contents:read、checkout 不持久化凭证；agent 步骤 env 只给当前后端的那一个 key，R2 与 Telegram 密钥只出现在 publish job。
- R2 上传（playbook D6）从 agent 手里收回，改由 publish job 的确定性步骤执行；agent 在 Actions 模式下止于 D7。
- publish job 依次跑渲染、R2 上传、QA、密钥扫描、日期精确提交、部署确认，确认通过后才发 Telegram；确认失败不发正常推送、job 失败告警。
- playbooks/daily.md 与 docs/ACTIONS.md 同步改职责划分与安全说明；契约测试同步加新断言；run-agent 只改安全注释，逻辑不动。

## Non-goals（这次明确不做什么）

- 不动 Muse 宿主模式与本机手动流程（只改 Actions workflow 与其契约文档）。
- 不新增 vars/secrets 名称（部署确认用公开 URL 轮询，不引 Cloudflare API token）。
- 不做自动回滚（失败时 job 失败 + 告警，手动 revert，步骤写进文档）。
- 不改编辑口径、产出格式与 QA 检查项本身。
- 不改 README 概览与 docs/SETUP.md（前者路径 B 描述仍准确，后者对 workflow 的一句话定性仍准确）。

## 影响文件清单

- 代码文件：
  - `.github/workflows/daily.yml`（拆 job、权限与 env 分工、部署确认步骤）
  - `scripts/check-edition-secrets.py`（新增：对待提交路径做启发式密钥扫描）
  - `scripts/verify-deploy.py`（新增：轮询线上首页/feed/抽查图片，确认部署）
  - `scripts/check-actions-contract.py`（契约测试同步：跨 job 检查 + 新权限断言）
  - `scripts/run-agent`（仅注释：安全边界改为 job 级隔离，逻辑不动）
- 文档 / 配置：
  - `playbooks/daily.md`（D5/D6/D8/D9 职责划分、护栏与完成判据）
  - `docs/ACTIONS.md`（按 job 拆分的密钥说明、部署确认、故障排查新增行）
- 定时任务：`.github/workflows/daily.yml` 本身（触发时间与守卫变量不变）。
- 提案归档：`docs/proposals/2026-11-04-actions-permission-isolation.md`（本文件）。
- 仓库同步三处自查：☑ 代码 □ docs/SETUP.md（引用处仍准确，不改） □ README.md（概览无变化，不改）

## 验收标准

- agent 步骤 env 里 grep 不到 R2、Telegram、非当前后端 key；edit job 里 `git push` 实测失败（无凭证）。
- agent 改掉 `qa-check.py` 再跑：publish job 的 QA 不受影响（干净 checkout）。
- agent 往 edition 里藏一段假密钥：密钥扫描拦下提交。
- 模拟 Pages 构建失败：Telegram 正常推送不发出，job 失败且报错能定位到“部署确认超时”。
- 正常路径 `workflow_dispatch` 端到端一次（或本地等价验证）：Telegram 文案仍是“已上线”且确实已上线。
- `scripts/check-actions-contract.py` 全过；`tests/run_agent_test.py` 全过；`npm test` 全过。

## 回滚

- 恢复到本次改动前的提交（单个提交内含全部改动时直接 revert 该提交）；或把 `NEWSFORGE_DAILY_ENABLED` 改成非 `true` 立刻停掉 Actions 日更，改回 Muse 模式/手动跑。
- 注意：回滚后 P0-1/P0-2 回到未修复状态，仅作应急止血用。

## grill 批复（站长填写）

<!-- 状态：待批复 / 已批复 / 已否决 / 已搁置 -->
