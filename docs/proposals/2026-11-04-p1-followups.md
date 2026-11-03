# 变更提案：第二轮 P1 跟进（日期统一、内容哈希版本校验、R2 一致性、测试拆分）

> 提案来源：2026-11-04 外部复评（8.6/10）指出的 4 个 P1 与 2 个附带点，
> 经逐项核查代码后的跟进；2026-11-04 用户定稿（同意顺序与修正方向，
> 并补充内容哈希细节、测试拆分与发布幂等性）。
> 本轮定名：Newsforge Reliability Hardening — Round 2。
> P1-3（Agent 持有自身模型 key）为已知接受项，本次不动。
> 状态：已批复（用户 2026-11-04 定稿并批准推送）。

## 标题

第二轮 P1 跟进：日期统一、内容哈希版本校验、R2 一致性、测试拆分。

## 为什么

- P1-1：edit 与 publish 各自算 TODAY，跨午夜运行会错位导致发布失败。
- P1-2：部署确认用详情页 URL 作标记，同日二次发布与全沿用时可误判通过。
- P1-4：R2 开关（workflow var 与 site.json flag）不一致时失效不直观；
  上传在 QA 之前的顺序只有约定、没有静态断言锁死；R2 模式下未上传的
  本地图片引用没有 QA 检查覆盖。
- 附带：npm test 未纳入契约测试与 agent 模拟测试，且未按职责拆分；
  README“零成本、零运维”为绝对化表达。

## 改什么

- 日期改为一次运行不可变参数：edit job 计算后经 job outputs 传给 publish job，
  publish 不再重算；单独重试 publish 时同样取原 edit 的日期。
- 部署确认改为版本级：publish 在 R2 改写与最终渲染之后算当期 edition JSON 的
  sha256，写进 `public/build-id.json`（字段 `editionSha256`，明确为“内容版本
  标记”而非整站构建版本）一并提交；verify-deploy 比对线上该文件的哈希是否全等。
  （复评建议的 commit SHA 因提交后才产生、无法预嵌，改用内容哈希。）
- 明确边界：edition 内容相同但模板/CSS/JS 变化时，内容哈希不变、无法证明新
  代码已部署——这是本方案的明确边界，不为此增加复杂度。
- publish 配置校验断言 R2 开关一致（var 与 site.json flag 不一致直接失败）；
  契约测试断言 R2 上传步在 QA 步之前、上传步无 continue-on-error（上传失败
  即中止发布）；QA 新增 R2 模式本地引用检查（仅 publish 阶段生效，见下）。
- QA 的 R2 本地引用检查：R2 模式下当期 edition 仍有本地 /images/ 引用即判失败；
  因 edit 阶段 agent 本地自查时图片尚未上传，该检查只在
  `NEWSFORGE_QA_AFTER_UPLOAD=1` 时生效（publish job 的 QA 步设置它）。
- npm scripts 按职责拆分：test:unit / test:contract / test:agent / qa，
  test 依次跑四者；publish job 仍跑 `npm test`（现阶段规模下可接受，
  长期可由模板开发 CI 负责完整测试、发布流程只做内容 QA 与运行时检查）。
- README 措辞软化：成本口径拆为已有订阅 / BYOK / Cloudflare 免费额度三档。
- 发布幂等性（三态，皆由内容哈希机制实现，见下“幂等性”一节）。

## Non-goals（这次明确不做什么）

- 不动 P1-3（Agent 持有自身模型 key）：已知接受项。
- 不做 mock R2 的真端到端集成测试（成本重；先以一致性断言 + 顺序断言 +
  QA 检查覆盖）。
- 不做自动回滚；不改编辑口径、产出格式与 QA 检查项本身（除新增 R2 一项）。
- 不改 Muse 宿主模式与触发时间、守卫变量；不把 publish 的完整测试拆出
  workflow（现阶段规模下可接受，见上）。

## 影响文件清单

- 代码文件：
  - `.github/workflows/daily.yml`（日期 outputs 传递、R2 一致性断言、build-id
    标记步骤、QA 步设 NEWSFORGE_QA_AFTER_UPLOAD=1、pyyaml 安装）
  - `scripts/verify-deploy.py`（editionSha256 全等校验）
  - `scripts/check-actions-contract.py`（日期传递、build-id、R2 顺序与失败中止、
    public 拷贝、QA 环境变量、npm 拆分断言）
  - `pipeline/qa-check.py`（R2 模式本地引用检查，publish 阶段生效）
  - `package.json`（test 拆分为 test:unit / test:contract / test:agent / qa）
- 文档 / 配置：
  - `playbooks/daily.md`（日期不可变、内容版本标记、部署确认版本级）
  - `docs/ACTIONS.md`（日期传递、内容版本标记、R2 一致性、幂等三态、故障排查新增行）
  - `README.md`（仅成本措辞软化，无结构变化）
- 定时任务：`.github/workflows/daily.yml` 本身（触发时间与守卫变量不变）。
- 提案归档：`docs/proposals/2026-11-04-p1-followups.md`（本文件）。
- 仓库同步三处自查：☑ 代码 ☑ docs/ACTIONS.md（行为变化处） □ docs/SETUP.md（未涉及 Actions 内部细节，不改） ☑ README.md（仅措辞）

## 幂等性（三态）

- 本次内容与线上内容相同（editionSha256 全等）：视为幂等成功，即使是重跑。
- 本次内容不同：必须等新内容部署成功（线上哈希追上本次哈希）才算成功，
  否则部署确认超时失败。
- 本次内容不存在于线上：不能因为今日 Edition 文件已在仓库就认为发布成功
  ——哈希比对不通过即失败，不发正常推送。
- 实现要点：提交步“edition 已在仓库则跳过提交”是安全的，因为跳过后仍走
  哈希比对；只有哈希全等才放行。

## 验收标准

- YAML 结构检查：edit job 定义 outputs.today；publish 步骤使用
  `needs.edit.outputs.today` 且不再含日期重算；build-id 标记步骤在提交步之前。
- verify-deploy 本地实测：本地 HTTP 服一个假站点，editionSha256 一致通过、
  不一致失败；全沿用（无今日链接）时 editionSha256 仍能判定。
- R2 开关不一致时 publish 配置校验失败（本地等价验证：抽出校验片段跑 4 种组合）。
- QA 新增项实测：R2 模式 + 本地图片引用时，publish 阶段（环境变量置位）判失败，
  非 publish 阶段不判。
- `scripts/check-actions-contract.py` 全过；`tests/run_agent_test.py` 全过；
  `npm test` 全过（含拆分后的四项）。
- README 措辞：不再有无条件的“零成本、零运维”绝对化表达。
- 本轮完成标准（需真实环境）：一次真实 Actions 发布、一次同日重跑、
  一次跨午夜模拟、一次部署验证失败的测试——前三项与最后一项中的
  “真实 Actions”部分无法在本地模拟，需在真实仓库运行后补验。

## 回滚

- 恢复到本次改动前的提交（单个提交内含全部改动时直接 revert 该提交）；
  或把 `NEWSFORGE_DAILY_ENABLED` 改成非 `true` 立刻停掉 Actions 日更。
- 注意：回滚后 P1-1/P1-2/P1-4 回到未修复状态，仅作应急止血用。

## grill 批复（站长填写）

<!-- 状态：待批复 / 已批复 / 已否决 / 已搁置 -->
