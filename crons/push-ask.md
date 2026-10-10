# 推送确认（用户起床时间）

## 目标
检查今晨构建结果，向用户汇报并**询问是否推送上线**。用户确认后才推送。

## 步骤
1. 确定今天日期（用户时区）。
2. 检查 `data/editions/YYYY-MM-DD.json` 是否存在且为今天构建：
   - 存在 → 读取，统计各模块新内容条数、沿用情况、头条标题列表。
   - **沿用统计口径**：`carried` 是**模块级**字段（`sections[].carried`），汇报"X 条新 / Y 条沿用"必须先按模块级 carried 分组再数条目。
   - 不存在或构建失败 → 如实报告失败原因，询问用户如何处理（等修复 / 跳过今天）。
3. 向用户发送推送确认消息：今日摘要（各模块新内容数、沿用情况、头条标题）+ 明确询问"确认推送上线吗？"
4. **本任务不自动推送**。用户确认后：
   - **图片**：如 `features.r2.enabled` 且 R2 已配置 → 跑 `node pipeline/run.js --upload-images --date=YYYY-MM-DD`（当期新图传 R2，edition 改写为公网 URL 并重渲染；缺图则不发布），逐个 curl 验证图片 URL（HTTP 200 + `image/webp`）；否则走 b64 模式（图片进 git）。
     推送内容：edition JSON（+ R2 模式的 `data/image-dims.json`；b64 模式加新增图片 b64），单次批量提交，减少审批次数
   - 等约 3 分钟，curl 首页确认日期已更新
   - curl `/feed.xml` 确认 RSS 已同步到最新一期（**每次必查**）
   - 如 `features.telegram.enabled`，运行 `pipeline/push-telegram.py YYYY-MM-DD`（沿用模块自动跳过）
   - 上线后简要报告

## 注意
- 用户到起床后 30 分钟仍未回复，不要重复打扰；当天版本保持暂存
- 功能/设计类改动不随每日推送发布，只推 edition 数据和图片
