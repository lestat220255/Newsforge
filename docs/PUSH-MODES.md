# 推送方式：PAT vs 默认授权（给 AI Agent 看）

> **核心结论：只有 PAT 能支持全自动推送。** 默认的仓库授权（GitHub App / MCP `push_files`）每次推送都要用户在 App 里点审批，做不到无人值守。

## 两种推送通道

| | 默认授权（GitHub App） | PAT（个人访问令牌） |
|---|---|---|
| 原理 | Muse 的 GitHub App 代用户推送 | 用户亲手建的 token，Agent 拿 token 走 HTTPS 直推 |
| 每次推送 | **用户必须在 App 里点审批** | **零审批，静默完成** |
| 定时自动推送 | ❌ 做不到（凌晨 5 点没人点审批） | ✅ 可以 |
| `.github/workflows/` | ❌ 403 写不了（缺专用权限） | ✅ 能写 |
| 配置成本 | 零（装 App 即用） | 用户亲手建一次 token（约 2 分钟） |

## PAT 配置（Agent 引导用户，✋ 手动创建）

1. ✋ 用户：GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate new token (classic)
2. ✋ Note 填站名（如 `newsforge-push`），过期时间按用户喜好，权限只勾 **`repo`**
3. ✋ 用户把 `ghp_...` 发给 Agent（只显示一次）
4. 🤖 Agent：存 `~/.config/newsforge/github-pat`（600 权限，**绝不进 git、不记日志、不复述**），并配好：
   ```bash
   # ~/.config/newsforge/askpass.sh（700 权限）
   #!/bin/bash
   cat ~/.config/newsforge/github-pat
   ```
   推送时：`GIT_ASKPASS=~/.config/newsforge/askpass.sh git push`

## 推送模式（二选一，安装时问用户）

**A. 全自动（默认，推荐）**：每日构建 → 自动推送 → 上线后汇报。要求：PAT 已配置。

**B. 手动确认**：每日构建 → 汇报摘要问"推送吗" → 用户确认后推送。PAT 没配好时自动降级到这个模式（走默认授权，每次推送用户点一次审批）。

## Agent 守则

- 默认按 A 模式建定时任务；用户明确说"每次我要确认"才用 B。
- A 模式建任务前先检查 PAT 是否就绪；没就绪就带用户走上面的配置流程，配好再建。
- 推送内容只含 edition 数据和图片（R2 模式图片不进 git），功能/设计改动不随每日推送走。
- 推送后必查：首页日期已更新 + `/feed.xml` 已同步到最新一期。没验证不许说"上线了"。
