# 每日推送（用户起床时间）

> 推送模式见 `docs/PUSH-MODES.md`。**默认 A. 全自动**；用户选了 B 才走手动确认。

## A. 全自动（默认）

### 目标
检查今晨构建结果，**直接推送上线**，推送后向用户汇报。无需用户确认。

### 步骤
1. 确定今天日期（用户时区）。
2. 检查 `data/editions/YYYY-MM-DD.json` 是否存在且为今天构建：
   - 存在 → 读取，统计各模块新内容条数、沿用情况、头条标题列表。
   - **沿用统计口径**：`carried` 是**模块级**字段（`sections[].carried`），汇报"X 条新 / Y 条沿用"必须先按模块级 carried 分组再数条目。
   - 不存在或构建失败 → 如实报告失败原因，**不推送**，询问用户如何处理（等修复 / 跳过今天）。
3. **自动推送**（无需确认）：
   - **图片**：如 `features.r2.enabled` 且 R2 已配置 → 跑 `node pipeline/run.js --upload-images --date=YYYY-MM-DD`（当期新图传 R2，edition 改写为公网 URL 并重渲染；上传后逐个 curl 验证：HTTP 200 + `image/webp`，失败先修好再推）；否则走 b64 模式（图片进 git）。
   - **推送**：`GIT_ASKPASS=~/.config/newsforge/askpass.sh git push`（PAT 免审批；PAT 配在 `~/.config/newsforge/github-pat`，600 权限）。推送内容：edition JSON（+ R2 模式的 `data/image-dims.json`；b64 模式加新增图片 b64）。
   - 等约 3 分钟，curl 首页确认日期已更新
   - curl `/feed.xml` 确认 RSS 已同步到最新一期（**每次必查**）
   - 如 `features.telegram.enabled`，运行 `pipeline/push-telegram.py YYYY-MM-DD`（沿用模块自动跳过）
4. 推送后向用户汇报：今日摘要（各模块新内容数、沿用情况、头条标题）+ 上线确认。

### 注意
- 构建失败不推送，直接报告并询问用户
- 功能/设计类改动不随每日推送发布，只推 edition 数据和图片
- **绝不在日志/汇报中复述 PAT 值**

## B. 手动确认（用户明确要求才用）

步骤与 A 相同，但第 3 步改为：先向用户发送今日摘要并明确询问"确认推送上线吗？"，用户确认后再执行推送。PAT 未配置时走默认授权通道（每次推送用户在 App 点一次审批）。
