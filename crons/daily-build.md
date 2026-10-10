# 每日构建（起床前 1.5 小时）

## 目标
抓取各模块信源 → AI 编辑 → 生成今日 edition JSON → 本地构建 → **暂存，不推送**。

## 步骤
1. 确定今天日期（用户时区，见 `site.json` → `site.timezone`，格式 YYYY-MM-DD）。
2. 跑 `npm run fetch`（=`node pipeline/run.js --fetch-only`）：抓取 `modules/*/module.json` 里定义的全部信源，产出候选。
   注意：`npm run build` 在**没有** `LLM_API_KEY` 时只渲染已有版本、不抓取（见 README「两条运行路径」）。
3. AI 编辑（按各模块 `module.json` → `editorial` 口径 + `docs/SCRAPING.md` 策略）：
   - 每模块 1 头条 + 最多 5 条次条；头条须 48h 内最新，无够格则整版隐藏
   - 摘要铁律：每句话在原文有对应，找不到写"原文未提"；数字/人名/时间与原文一致
   - 待确认内容不做头条、沉底、不打 🔥
   - 无够格新内容且上一期有该模块 → 整版沿用（`carried:true`），连续沿用超 1 天则隐藏
   - 沿用内容不进 `dailyDigest.topPicks`（模板层有硬过滤，但 edition 里也别写）
4. 头条配图：`node pipeline/run.js --images`（如管线支持），校验 b64 与 edition 引用一一对应。
5. `npm test` 跑 QA（如 `features.qaChecks` 开启）。
6. 写 `data/editions/YYYY-MM-DD.ready` 状态文件，记录各模块新/沿用条数。
7. **到此为止，不推送。** 等"推送确认"任务。

## 注意
- 构建失败不要编造内容，直接记录失败原因，等用户处理。
- 任何密钥、token 不许进 git、不许进 edition JSON。
