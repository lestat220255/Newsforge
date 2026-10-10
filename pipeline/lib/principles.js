// Newsforge — 编辑原则库：id → { name, desc, prompt }
// 被 edit.js（prompt 注入）与 render.js（about 页渲染）共用。
// 默认不启用；用户在安装时多选，选中的 id 存 site.json → editorial.principles。
export const PRINCIPLES = {
  'no-filler': {
    name: '宁缺毋滥',
    desc: '相关性不够的候选一律舍弃，不为凑满条数降低标准；当天无够格内容则沿用前期版本并明确标注。',
    prompt:
      '宁缺毋滥：相关性不够的候选一律舍弃，绝不为凑满 5 条降低标准；无够格头条则该板块 hidden:true，无够格次条则次条留空，不拿弱相关内容凑数。',
  },
  'source-first': {
    name: '信源优先',
    desc: '优先选择有多家媒体报道的新闻；每条链接原样引用出处，不编造。',
    prompt:
      '信源优先：只收录有多家独立媒体报道的新闻，单信源新闻一律舍弃；每条 url 必须原样引用出处，绝不编造。',
  },
  'no-inference': {
    name: '只陈述，不推断',
    desc: '摘要与分析只写公开报道明确提到的内容，不确定的标注"待确认"。',
    prompt:
      '只陈述不推断：摘要与分析只写公开报道明确提到的内容；任何不确定的信息标注"待确认"，绝不脑补、绝不写"报道暗示/意味着"。',
  },
  'red-lines': {
    name: '红线',
    desc: '不收以特定个人为主要焦点的新闻；不做操作教程；不做投资建议。',
    prompt:
      '红线：不收以特定个人为主要焦点的新闻；不写任何操作教程；不写投资建议。命中红线的候选一律舍弃。',
  },
  'full-summary': {
    name: '头条摘要完整呈现',
    desc: '首页每条头条直接展示完整摘要与一句话点评，不用点进详情页也能读完当天的全部头条；不截断引流，不玩标题游戏。',
    prompt:
      '头条摘要完整呈现：头条摘要必须信息完整、独立成篇，读者不点进详情页也能读懂当天最重要的事；不写"欲知后事"式钩子。',
  },
  'credibility-badges': {
    name: '可信度标记',
    desc: '「待确认」表示单信源报道、关键信息尚未经多方证实；「多信源」表示有多家独立媒体交叉报道。不确定的我们会明说。',
    prompt:
      '可信度标记：每条必须打标——单信源或关键信息未经多方证实→"unverified":true；多家独立媒体交叉报道→"multi_source":true。不确定的明说，不许含糊。',
  },
};

/** 返回选中原则的 prompt 规则文本（未选中的不注入） */
export function principlesPrompt(ids = []) {
  return ids
    .filter((id) => PRINCIPLES[id])
    .map((id) => `   [编辑原则·${PRINCIPLES[id].name}] ${PRINCIPLES[id].prompt}`)
    .join('\n');
}

/** 返回选中原则的 about 页 HTML 列表项 */
export function principlesAboutHtml(ids = []) {
  return ids
    .filter((id) => PRINCIPLES[id])
    .map((id) => `<li><strong>${PRINCIPLES[id].name}</strong>：${PRINCIPLES[id].desc}</li>`)
    .join('\n    ');
}
