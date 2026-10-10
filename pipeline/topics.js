// 受控话题词表（示例）
// 中颗粒度话题：AI 只能从此表选标签，新话题标记待审。
// keywords 用于存量文章的启发式补标；日常构建由 AI 直接打标签。
// 安装时按你的模块领域替换这份词表。

export const TOPICS = [
  { name: 'AI', keywords: ['AI', 'artificial intelligence', 'LLM', 'ChatGPT', 'Claude', 'Gemini'] },
  { name: 'Open Source', keywords: ['open source', '开源', 'GitHub', 'repository'] },
  { name: 'Security', keywords: ['security', 'vulnerability', 'CVE', '安全', '漏洞'] },
];

export function topicUrl(name) { return '/topic/' + encodeURIComponent(name) + '/'; }
export function isValidTopic(name) { return TOPICS.some((t) => t.name === name); }
