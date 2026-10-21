# 信源推荐清单（给 AI Agent 看）

> 用户在 playbook Q2-2 选"用我推荐的信源"时，从这里挑对应领域的清单给用户勾选。
> 推荐前先用 `curl` 验证 RSS 可达，死的就划掉再推荐。
> 用户的领域不在下面？用通用方法找：目标网站首页找 `/feed`、`/rss`、`/feed.xml`，或用 `docs/SCRAPING.md` 的 weblist 方案。

## 科技 / AI

- TechCrunch AI — https://techcrunch.com/category/artificial-intelligence/feed/
- The Verge — https://www.theverge.com/rss/index.xml
- Ars Technica — https://feeds.arstechnica.com/arstechnica/index
- MIT Technology Review — https://www.technologyreview.com/topic/artificial-intelligence/feed/
- 404 Media — https://www.404media.co/rss/
- The Decoder — https://the-decoder.com/feed/
- 官方博客（标 T1，可单信源入选）：
  - OpenAI Blog — https://openai.com/news/rss.xml
  - Google Research Blog — https://research.google/blog/rss/
  - DeepMind Blog — https://deepmind.google/blog/rss.xml

## 开源

- GitHub Trending（weblist，需 CSS 选择器抓取）
- Lobsters — https://lobste.rs/rss
- Hacker News（官方 API：https://hacker-news.firebaseio.com/v0/topstories.json）
- Console.dev Newsletter — https://console.dev/rss.xml

## VPS / 云服务优惠

- LowEndBox — https://lowendbox.com/feed/
- VPSBenchmarks Blog — https://www.vpsbenchmarks.com/blog/feed

## 国际新闻

- BBC World — https://feeds.bbci.co.uk/news/world/rss.xml
- Reuters World — https://www.reuters.com/world/rss.xml（注意防盗链 UA）
- AP News — https://apnews.com/hub/world-news/feed

## 财经 / 美股

- CNBC Markets — https://www.cnbc.com/id/10000664/device/rss/rss.html
- MarketWatch — https://www.marketwatch.com/rss/marketpulse

## 通用补充源（任何领域都能用，降级机制）

- **GDELT**：主力源候选不足 10 条时才启用，标记 [补充源]，编辑优先选主力源
- **Mastodon 趋势**：`https://mastodon.social/api/v1/trends/links`（免认证），同 GDELT 降级

## 找新信源的方法

1. 先找 RSS（`/feed`、`/rss.xml`、页面 `<link rel="alternate">`）
2. 无 RSS 的列表页 → weblist 类型：cheerio + CSS 选择器，**避开 CSS module 哈希类名**，用属性选择器（如 `a[href^="/news/"]`）和语义标签（h4/time）定位
3. 有 UA 墙的站（如 anthropic.com）→ 在请求头加浏览器 UA
4. JS 渲染的重型站 → 先评估维护成本，搞不定就放弃，别硬上
