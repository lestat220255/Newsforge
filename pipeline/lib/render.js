// Newsforge 构建管线 — lib/render.js：全部静态渲染（首页/详情/归档/话题/RSS/sitemap/搜索索引）
// 依赖 utils / edit / images；被 run 调用。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { SITE, FEATURES, EDITORIAL } from '../site-config.js';
import { principlesAboutHtml } from './principles.js';
import { TOPICS, topicUrl, isValidTopic } from '../topics.js';
import { preloadImgDims, imgWH, IMG_DIR } from './images.js';
import { listEditions, loadEdition } from './edit.js';
import {
  HERE, ROOT, PIPELINE_DIR, DIST, DATA_DIR, EDITIONS_DIR, esc, googleSearchUrl, cleanComment,
  fmtDate, fmtDateCN, dateBadge, detailUrl, entryDate, parseTime, rfc2822, shortTitle,
} from './utils.js';

// 绝对图片 URL（R2 迁移）：已是 http(s) 直接用，否则拼站点域名
function absImg(u) {
  return u && u.startsWith('http') ? u : SITE.url + (u || '');
}

function assertNoChainedDetailDate(dates) {
  const byDate = new Map();
  for (const d of dates) {
    const ed = loadEdition(d);
    if (ed) byDate.set(d, ed);
  }
  const bad = [];
  for (const [d, ed] of byDate) {
    for (const sec of ed.sections || []) {
      const dd = sec.detailDate;
      if (!dd || dd === d) continue;
      const target = byDate.get(dd);
      const tsec = target && (target.sections || []).find((s) => s.id === sec.id);
      const tdd = tsec ? tsec.detailDate || dd : null;
      if (!tsec) bad.push(`${d}/${sec.id}: detailDate=${dd} 指向的期数无此板块`);
      else if (tdd !== dd) bad.push(`${d}/${sec.id}: detailDate=${dd} 是链式指向（目标仍指向 ${tdd}），应直接写 ${tdd}`);
    }
  }
  if (bad.length) throw new Error('detailDate 校验失败，构建中止：\n' + bad.join('\n'));
}
// 来源行：媒体 · 作者 · 原文发布日期

function sourceLine(entry) {
  const parts = [entry.source];
  if (entry.author) parts.push(entry.author);
  const dt = fmtDateCN(entry.publishedAt);
  if (dt) parts.push(dt);
  return parts.filter(Boolean).join(' · ');
}

// 可信度徽标（2026-10-07）：unverified=单信源未证实→「待确认」；multi_source=多家独立媒体交叉报道→「多信源」

function trustBadges(e) {
  if (!e) return '';
  let s = '';
  if (e.unverified) s += '<span class="badge badge-pending">待确认</span>';
  if (e.multi_source) s += '<span class="badge badge-multi">多信源</span>';
  if (e.is_update) s += '<span class="badge badge-update">更新</span>';
  return s;
}
// 🔥 铁律（2026-10-07）：待确认条目永不带 🔥，模板层硬压制，AI 误标也不显示

function hotMark(e) {
  return e && e.hot && !e.unverified ? '🔥' : '';
}

// 图片宽高预读（2026-10-07）：构建时读 webp 实际尺寸，模板输出 width/height 防布局偏移

function renderSection(sec, date) {
  const dDate = sec.detailDate || date;
  if (sec.empty || sec.hidden) {
    return '';
  }
  const h = sec.headline;
  const headHtml = h
    ? `<article class="headline"${h.sensitive ? ' data-sensitive="1"' : ''}>
      <div class="kicker">头条 ${sec.carried ? '<span class="carried">沿用前期版本</span>' : ''} ${dateBadge(h.publishedAt)}</div>
      ${h.image ? `<a class="himg-link" href="${detailUrl(dDate, sec.id, 0)}" aria-label="${esc(h.title)}"><img class="himg" src="${esc(h.image)}"${imgWH(h.image)} alt="" loading="lazy"></a>` : ''}
      <h3><a href="${detailUrl(dDate, sec.id, 0)}">${hotMark(h)}${esc(h.title)}${trustBadges(h)}</a></h3>
      <p class="summary">${esc(h.summary)}</p>
      ${h.comment ? `<p class="comment">AI 点评：${esc(cleanComment(h.comment))}</p>` : ''}
      <div class="meta">来源：${esc(sourceLine(h))} · <a href="${esc(h.url)}" target="_blank" rel="noopener" aria-label="阅读原文：${esc(h.title)}">阅读原文</a><button class="copy-btn" data-title="${esc(h.title)}" data-url="${esc(h.url)}" aria-label="复制标题和原文链接">复制</button><a class="search-btn" href="${esc(googleSearchUrl(h.title))}" target="_blank" rel="noopener" aria-label="在 Google 搜索此标题">搜索</a></div>
    </article>`
    : '';
  const itemsHtml = (sec.items || [])
    .map(
      (it, i) => `<li${it.sensitive ? ' data-sensitive="1"' : ''}>${dateBadge(it.publishedAt)}
      <span class="t"><a href="${detailUrl(dDate, sec.id, i + 1)}">${hotMark(it)}${esc(it.title)}${trustBadges(it)}</a></span>
      <span class="b">${esc(it.blurb || it.desc || '')}</span>
      <span class="s">${esc(it.source || '')}</span><button class="copy-btn" data-title="${esc(it.title)}" data-url="${esc(it.url)}" aria-label="复制标题和原文链接">复制</button><a class="search-btn" href="${esc(googleSearchUrl(it.title))}" target="_blank" rel="noopener" aria-label="在 Google 搜索此标题">搜索</a></li>`,
    )
    .join('');
  return `<section id="${esc(sec.id)}" data-pagefind-body>
    <h2>${esc(sec.name)}<small>${esc(sec.desc || '')}</small></h2>
    ${headHtml}
    ${itemsHtml ? `<ul class="secondary">${itemsHtml}</ul>` : ''}
  </section>`;
}

// 今日要览条（2026-10-08）：通栏分隔带；topPicks 只取 hot 头条、≤3 条、无则不渲染该模块

function renderDigest(edition) {
  const d = edition.dailyDigest;
  if (!d) return '';
  const picks = (d.topPicks || [])
    .map((p) => {
      const sec = edition.sections.find((s) => s.id === p.section);
      // 沿用板块一律不进入"今日最值得看"（2026-10-10）：模板层硬过滤，防 edition 手误写入
      if (!sec || sec.hidden || sec.empty || sec.carried) return '';
      const entry = p.index === 0 ? sec.headline : (sec.items || [])[p.index - 1];
      if (!entry) return '';
      const dDate = sec.detailDate || edition.date;
      return `<li${entry.sensitive ? ' data-sensitive="1"' : ''}><span class="sec-tag">${esc(sec.name)}</span><a href="${detailUrl(dDate, sec.id, p.index)}">${esc(entry.title)}</a></li>`;
    })
    .filter(Boolean)
    .join('');
  return `<div class="digest" data-pagefind-ignore>
    <div class="digest-top"><span class="digest-issue"><strong>第 ${d.issue} 期</strong>${esc(d.dateLabel)}</span><span class="digest-stats">${d.stats.items} 条更新 · ${d.stats.sources} 个来源 · 约 ${d.stats.readMinutes} 分钟读完</span></div>
    ${d.oneLiner ? `<p class="digest-oneliner">${esc(d.oneLiner)}</p>` : ''}
    ${picks ? `<div class="digest-picks"><div class="digest-picks-title">今日最值得看</div><ul>${picks}</ul></div>` : ''}
  </div>`;
}

function renderPage(tpl, edition, dates, canonical, showTgBanner) {
  const visibleSections = edition.sections.filter((s) => !s.empty && !s.hidden);
  const digestHtml = renderDigest(edition);
  const sectionsHtml = visibleSections.map((s) => renderSection(s, edition.date)).join('\n');
  const archiveOpts = (() => {
    // 按月分组（optgroup），日期多了以后下拉框好找
    const byMonth = {};
    for (const d of dates) {
      const m = d.slice(0, 7);
      (byMonth[m] = byMonth[m] || []).push(d);
    }
    return Object.keys(byMonth)
      .sort()
      .reverse()
      .map((m) => {
        const [y, mo] = m.split('-');
        const opts = byMonth[m]
          .map((d) => `<option value="/archive/${d}/"${d === edition.date ? ' selected' : ''}>${d}</option>`)
          .join('');
        return `<optgroup label="${y} 年 ${mo} 月">${opts}</optgroup>`;
      })
      .join('');
  })();
  const navLinks = visibleSections.map((s) => `<a href="#${esc(s.id)}">${esc(s.name)}</a>`).join('');
  // og:image：用第一个有配图的头条， fallback 到图标
  const firstImg = visibleSections.map((s) => s.headline?.image).find(Boolean);
  const ogImage = firstImg ? absImg(firstImg) : SITE.url + '/favicon.png';
  const tgOn = showTgBanner && FEATURES.telegram.enabled && FEATURES.telegram.channel;
  const tgBanner = tgOn ? `<div class="tg-banner" id="tg-banner"><span class="msg">📡 在 Telegram 上订阅 ${esc(SITE.name)}，每早同步推送当日头条</span><a class="sub-btn" href="https://t.me/${esc(FEATURES.telegram.channel)}" target="_blank" rel="noopener">订阅 →</a><button class="close" aria-label="关闭">×</button></div>` : '';
  return tpl
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SITE_URL}}', esc(SITE.url))
    .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
    .replaceAll('{{DATE}}', esc(edition.date))
    .replaceAll('{{CANONICAL}}', esc(canonical))
    .replaceAll('{{OG_IMAGE}}', esc(ogImage))
    .replaceAll('{{NAV}}', navLinks)
    .replaceAll('{{SECTIONS}}', sectionsHtml)
    .replaceAll('{{DIGEST}}', digestHtml)
    .replaceAll('{{ARCHIVE_OPTS}}', archiveOpts)
    .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer))
    .replaceAll('{{TG_BANNER}}', tgBanner)
    .replaceAll('{{BUILD_TIME}}', esc(new Date().toISOString()));
}

function extractKeywords(text) {
  if (!text) return { strong: new Set(), weak: new Set() };
  const strong = new Set(), weak = new Set();
  // 英文词/数字：通常是专有名词，强信号
  (text.match(/[A-Za-z0-9]+(?:[.\-][A-Za-z0-9]+)*/g) || [])
    .filter((w) => w.length >= 3)
    .forEach((w) => strong.add(w.toLowerCase()));
  const cn = text.replace(/[^\u4e00-\u9fa5]/g, '');
  const stop = '的了在和与等为是有将已不也都而及或这那其之于对就但被把让向从到以因最更很太';
  // 3-4字短语：强信号；2字词：弱信号
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i <= cn.length - n; i++) {
      const w = cn.slice(i, i + n);
      if ([...w].some((c) => stop.includes(c))) continue;
      // 长词优先：若已被更长的词覆盖则跳过
      let covered = false;
      for (const s of strong) if (s.includes(w) && s !== w) { covered = true; break; }
      if (covered) continue;
      (n >= 3 ? strong : weak).add(w);
    }
  }
  return { strong, weak };
}

// 相关往期报道：强关键词(专有名词/3-4字短语)命中才算相关
// 同板块≥6分，跨板块≥8分，最多3条
// allArticles: [{date, secId, secName, idx, title, summary, url}]

function findRelated(cur, allArticles) {
  const curT = extractKeywords(cur.entry.title);
  const curS = extractKeywords(cur.entry.summary || '');
  const results = [];
  for (const a of allArticles) {
    if (a.date >= cur.date || (a.date === cur.date && a.secId === cur.sec.id && a.idx === cur.idx)) continue;
    const sameSec = a.secId === cur.sec.id;
    const aKw = a.kw;
    let strongHits = 0, score = sameSec ? 2 : 0;
    for (const w of curT.strong) if (aKw.strong.has(w)) { strongHits++; score += 3; }
    for (const w of curT.weak) if (aKw.strong.has(w) || aKw.weak.has(w)) score += 1;
    for (const w of curS.strong) if (aKw.strong.has(w)) score += 1;
    // 必须至少1个强关键词命中，否则不算相关
    if (!strongHits) continue;
    const threshold = sameSec ? 6 : 8;
    if (score >= threshold) results.push({ ...a, score });
  }
  // 兜底去重（2026-10-07）：按详情页 URL 去重后再取前 3，防止任何未知路径产生重复条目
  const uniq = [];
  const seenU = new Set();
  for (const r of results.sort((a, b) => b.score - a.score)) {
    if (seenU.has(r.url)) continue;
    seenU.add(r.url);
    uniq.push(r);
    if (uniq.length >= 3) break;
  }
  return uniq;
}

function renderDetail(tpl, ed, cur, prev, next, allArticles) {
  const { sec, idx, entry, isHeadline } = cur;
  const summary = isHeadline ? entry.summary || '' : entry.summary || entry.blurb || entry.desc || '';
  const analysisHtml = (entry.analysis || '暂无分析。')
    .split(/\n\n+/)
    .map((p) => `<p>${esc(p.trim())}</p>`)
    .join('\n      ');
  // 核心事实卡（2026-10-08）：长原文的 3-6 条关键事实，摘要之后、分析之前
  const keyFactsHtml = Array.isArray(entry.keyFacts) && entry.keyFacts.length
    ? `<section class="block"><h2>核心事实</h2><ul class="facts">` +
      entry.keyFacts.map((f) => `<li>${esc(String(f).trim())}</li>`).join('\n      ') +
      `</ul></section>`
    : '';
  const mainLink = `<li><a href="${esc(entry.url)}" target="_blank" rel="noopener">阅读原文：${esc(entry.title)}</a><span class="s">${esc(entry.source || '')}</span></li>`;
  const searchLink = `<li><a href="${esc(googleSearchUrl(entry.title))}" target="_blank" rel="noopener">在 Google 搜索此标题</a><span class="s">看多方报道与 AI 总结</span></li>`;
  // 相关往期报道：本站归档中同主题旧文（关键词匹配，同板块≥6分/跨板块≥8分）
  const related = findRelated({ ...cur, date: ed.date }, allArticles || []);
  const relatedHtml = related.length
    ? `<section class="block"><h2>相关往期报道</h2><ul class="links">` +
      related
        .map((r) => `<li><a href="${esc(r.url)}">${esc(r.title)}</a><span class="s">${esc(r.date)} · ${esc(r.secName)}</span></li>`)
        .join('\n      ') +
      `</ul></section>`
    : '';
  const pn = (item, label, cls) =>
    item
      ? `<a class="pn ${cls}" href="${item.url}">${label}：${esc(shortTitle(item.entry.title, 22))}</a>`
      : `<span class="pn ${cls} disabled">${label}（已是${cls === 'prev' ? '第一' : '最后'}篇）</span>`;
  const canonical = SITE.url + cur.url;
  // 面包屑/返回首页指向文章所属日期的归档页，而非当日首页（2026-10-06 修复）
  const archiveUrl = `/archive/${ed.date}/`;
  const ogImage = entry.image ? absImg(entry.image) : (sec.headline && sec.headline.image ? absImg(sec.headline.image) : SITE.url + '/favicon.png');
  const ogDesc = summary.length > 140 ? summary.slice(0, 140) + '…' : summary;
  return tpl
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SEC_NAME}}', esc(sec.name))
    .replaceAll('{{SEC_ID}}', esc(sec.id))
    .replaceAll('{{TITLE}}', esc(entry.title))
    .replaceAll('{{TRUST_BADGES}}', trustBadges(entry) ? `<div class="trust-badges">${trustBadges(entry)}</div>` : '')
    .replaceAll('{{TITLE_SHORT}}', esc(shortTitle(entry.title)))
    .replaceAll('{{CANONICAL}}', esc(canonical))
    .replaceAll('{{ARCHIVE_URL}}', esc(archiveUrl))
    .replaceAll('{{SENSITIVE_ATTR}}', entry.sensitive ? ' data-sensitive="1"' : '')
    .replaceAll('{{OG_IMAGE}}', esc(ogImage))
    .replaceAll('{{OG_DESC}}', esc(ogDesc))
    .replaceAll('{{PUBLISHED_BADGE}}', dateBadge(entry.publishedAt))
    .replaceAll('{{TOPIC_TAGS}}', (entry.topics || []).filter(isValidTopic).length
      ? `<div class="topic-tags">` + (entry.topics || []).filter(isValidTopic).map(t =>
          `<a href="${esc(topicUrl(t))}">${esc(t)}</a>`).join('') + `</div>`
      : '')
    .replaceAll('{{SOURCE}}', esc(entry.source || ''))
    .replaceAll('{{URL}}', esc(entry.url))
    .replaceAll('{{DIMG}}', entry.image ? `<img class="dimg" src="${esc(entry.image)}"${imgWH(entry.image)} alt="" loading="lazy">` : '')
    .replaceAll('{{SUMMARY}}', esc(summary))
    .replaceAll('{{KEY_FACTS}}', keyFactsHtml)
    .replaceAll('{{ANALYSIS}}', analysisHtml)
    .replaceAll('{{LINKS}}', mainLink + '\n      ' + searchLink)
    .replaceAll('{{RELATED}}', relatedHtml)
    .replaceAll('{{PREV}}', pn(prev, '← 上一篇', 'prev'))
    .replaceAll('{{NEXT}}', pn(next, '下一篇 →', 'next'))
    .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer));
}

function renderDetailPages(dates) {
  const tpl = readFileSync(join(PIPELINE_DIR, 'detail-template.html'), 'utf8');
  const urls = [];
  // 全站文章索引（供相关往期报道匹配）
  // 去重铁律（2026-10-07）：沿用（carried）板块保留原 detailDate，详情页 URL 与原版完全相同；
  // 若不按 URL 去重，同一篇文章会在索引里出现两次，"相关往期报道"就会显示重复条目
  const allArticles = [];
  const seenDetailUrls = new Set();
  const pushArticle = (a) => {
    if (seenDetailUrls.has(a.url)) return;
    seenDetailUrls.add(a.url);
    allArticles.push(a);
  };
  for (const d of dates) {
    const ed2 = loadEdition(d);
    if (!ed2) continue;
    for (const sec of ed2.sections) {
      if (sec.empty) continue;
      const dDate = entryDate(ed2, sec);
      if (sec.headline)
        pushArticle({ date: dDate, secId: sec.id, secName: sec.name, idx: 0, title: sec.headline.title, summary: sec.headline.summary || '', url: detailUrl(dDate, sec.id, 0), kw: extractKeywords(sec.headline.title + ' ' + (sec.headline.summary || '')) });
      (sec.items || []).forEach((it, i) =>
        pushArticle({ date: dDate, secId: sec.id, secName: sec.name, idx: i + 1, title: it.title, summary: it.summary || '', url: detailUrl(dDate, sec.id, i + 1), kw: extractKeywords(it.title + ' ' + (it.summary || '')) }),
      );
    }
  }
  for (const d of dates) {
    const ed = loadEdition(d);
    if (!ed) continue;
    // 当天首页展示顺序：板块顺序 → 头条(0) → 次条(1..n)
    const order = [];
    for (const sec of ed.sections) {
      if (sec.empty) continue;
      const dDate = entryDate(ed, sec);
      const gen = dDate === d; // 沿用板块的详情页已在原日期生成过，不重复生成
      if (sec.headline) order.push({ sec, idx: 0, entry: sec.headline, isHeadline: true, url: detailUrl(dDate, sec.id, 0), gen });
      (sec.items || []).forEach((it, i) =>
        order.push({ sec, idx: i + 1, entry: it, isHeadline: false, url: detailUrl(dDate, sec.id, i + 1), gen }),
      );
    }
    order.forEach((cur, pos) => {
      if (!cur.gen) return;
      // 上一篇/下一篇只在同板块内，不跨板块
      const sameSec = order.filter((o) => o.sec.id === cur.sec.id);
      const si = sameSec.findIndex((o) => o.idx === cur.idx);
      const prev = si > 0 ? sameSec[si - 1] : null;
      const next = si < sameSec.length - 1 ? sameSec[si + 1] : null;
      const html = renderDetail(tpl, ed, cur, prev, next, allArticles);
      const dir = join(DIST, 'detail', d, `${cur.sec.id}-${cur.idx}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), html);
      urls.push({ loc: SITE.url + cur.url, lastmod: d });
    });
  }
  console.log('详情页渲染完成');
  return urls;
}

function renderFeedXml(edition) {
  const items = [];
  for (const sec of edition.sections) {
    if (sec.empty) continue;
    const dDate = sec.detailDate || edition.date;
    const pushItem = (entry, idx, isHeadline) => {
      const summary = isHeadline ? entry.summary || '' : entry.summary || entry.blurb || entry.desc || '';
      let desc = `<p><strong>${esc(sec.name)}</strong></p>`;
      if (summary) desc += `<p>${esc(summary)}</p>`;
      if (isHeadline && entry.comment) desc += `<p>AI 点评：${esc(cleanComment(entry.comment))}</p>`;
      const link = SITE.url + detailUrl(dDate, sec.id, idx);
      items.push({ title: entry.title || '(无标题)', link, desc, pubDate: rfc2822(entry.publishedAt) });
    };
    if (sec.headline) pushItem(sec.headline, 0, true);
    (sec.items || []).forEach((it, i) => pushItem(it, i + 1, false));
  }
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n` +
    `<title>${esc(SITE.name)}</title>\n<link>${esc(SITE.url + '/')}</link>\n` +
    `<description>${esc(SITE.tagline)}</description>\n<language>zh-CN</language>\n` +
    `<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n` +
    items
      .map(
        (it) =>
          `<item>\n<title>${esc(it.title)}</title>\n<link>${esc(it.link)}</link>\n` +
          `<guid>${esc(it.link)}</guid>\n<pubDate>${it.pubDate}</pubDate>\n` +
          `<description><![CDATA[${it.desc}]]></description>\n</item>`,
      )
      .join('\n') +
    `\n</channel>\n</rss>\n`;
  writeFileSync(join(DIST, 'feed.xml'), xml);
  console.log(`RSS 已生成：${items.length} 条`);
}

// 归档索引页：/archive/，按月分组折叠（<details>），每组内按日期倒序，每期列头条标题+摘要

function renderArchiveIndex(allDates) {
  const tpl = readFileSync(join(PIPELINE_DIR, 'archive-index-template.html'), 'utf8');
  // 按月分组：{ 'YYYY-MM': [dates...] }，日期已是倒序
  const byMonth = {};
  for (const d of allDates) {
    const m = d.slice(0, 7);
    (byMonth[m] = byMonth[m] || []).push(d);
  }
  const months = Object.keys(byMonth).sort().reverse();
  const blocks = months
    .map((m, mi) => {
      const [y, mo] = m.split('-');
      const sections = byMonth[m]
        .map((d) => {
          const ed = loadEdition(d);
          if (!ed) return '';
          const heads = [];
          for (const sec of ed.sections) {
            if (sec.empty || !sec.headline) continue;
            const dDate = sec.detailDate || d;
            const h = sec.headline;
            heads.push(
              `<li><span class="sec">${esc(sec.name)}</span>` +
                `<span class="t"><a href="${detailUrl(dDate, sec.id, 0)}">${esc(h.title)}${trustBadges(h)}</a></span>` +
                (h.summary ? `<p class="sum">${esc(h.summary)}</p>` : '') +
                `</li>`,
            );
          }
          if (!heads.length) return '';
          return (
            `<section class="ed"><h2><a href="/archive/${d}/">${d}</a>` +
            `<span class="cnt">${heads.length} 条头条</span></h2>\n` +
            `<ul class="hl">\n${heads.join('\n')}\n</ul></section>`
          );
        })
        .filter(Boolean)
        .join('\n');
      if (!sections) return '';
      const cnt = byMonth[m].length;
      return (
        `<details class="month"${mi === 0 ? ' open' : ''}>` +
        `<summary>${y} 年 ${mo} 月<span class="mcnt">${cnt} 期</span></summary>\n` +
        sections +
        `</details>`
      );
    })
    .join('\n');
  const html = tpl
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SITE_URL}}', esc(SITE.url))
    .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
    .replaceAll('{{ARCHIVE_LIST}}', blocks || '<p>暂无归档</p>')
    .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer))
    .replaceAll('{{BUILD_TIME}}', esc(new Date().toISOString()));
  mkdirSync(join(DIST, 'archive'), { recursive: true });
  writeFileSync(join(DIST, 'archive', 'index.html'), html);
  console.log('归档索引页已生成');
}

function renderTopicPages(dates) {
  // 收集所有带话题的文章，按话题分组
  const byTopic = new Map(); // topicName -> [{date, secName, secId, title, url, publishedAt}]
  for (const d of dates) {
    const ed = loadEdition(d);
    if (!ed) continue;
    for (const sec of ed.sections || []) {
      if (sec.hidden) continue;
      const secName = sec.name || '';
      const secId = sec.id || '';
      const entries = [];
      if (sec.headline) entries.push({ ...sec.headline, isHeadline: true });
      for (const it of sec.items || []) entries.push({ ...it, isHeadline: false });
      for (const e of entries) {
        const topics = (e.topics || []).filter(isValidTopic);
        if (!topics.length) continue;
        // 详情页 URL：/detail/<date>/<secId>-<idx>/（沿用板块必须用 detailDate，否则链出的 URL 与实际生成的对不上）
        const idx = e.isHeadline ? 0 : (sec.items || []).findIndex(it => it.url === e.url) + 1;
        const dDate = sec.detailDate || d;
        const durl = `/detail/${dDate}/${secId}-${idx}/`;
        for (const t of topics) {
          if (!byTopic.has(t)) byTopic.set(t, []);
          byTopic.get(t).push({
            date: d, secName, title: e.title || '',
            url: durl, publishedAt: e.publishedAt || '',
            unverified: !!e.unverified, multi_source: !!e.multi_source, is_update: !!e.is_update,
          });
        }
      }
    }
  }
  const topicUrls = [];
  const tpl = readFileSync(join(PIPELINE_DIR, 'topic-template.html'), 'utf8');
  const BUILD_TIME = new Date().toISOString();
  // 按话题名排序，保证稳定输出
  const sortedTopics = [...byTopic.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  for (const tname of sortedTopics) {
    const articles = byTopic.get(tname)
      .sort((a, b) => (b.publishedAt || '') > (a.publishedAt || '') ? 1 : -1);
    const listHtml = articles.map(a =>
      `<div class="arch-item"><span class="d">${esc(a.date)}</span> <span class="s">[${esc(a.secName)}]</span> <a href="${esc(a.url)}">${esc(a.title)}${trustBadges(a)}</a></div>`
    ).join('\n');
    const url = SITE.url + topicUrl(tname);
    const html = tpl
      .replaceAll('{{SITE_NAME}}', esc(SITE.name))
      .replaceAll('{{SITE_URL}}', esc(SITE.url))
      .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
      .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer))
      .replaceAll('{{TOPIC_NAME}}', esc(tname))
      .replaceAll('{{TOPIC_URL}}', esc(url))
      .replaceAll('{{TOPIC_ARTICLES}}', listHtml)
      .replaceAll('{{BUILD_TIME}}', esc(BUILD_TIME));
    const dir = join(DIST, 'topic', tname);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), html);
    topicUrls.push({ loc: url, lastmod: articles[0]?.date || '' });
  }
  // 话题索引页 /topics/
  const idxTpl = readFileSync(join(PIPELINE_DIR, 'topics-index-template.html'), 'utf8');
  const topicsListHtml = sortedTopics.map(tname => {
    const n = byTopic.get(tname).length;
    return `<div class="arch-item"><a href="${esc(topicUrl(tname))}">${esc(tname)}</a> <span class="s">${n} 篇</span></div>`;
  }).join('\n') || '<p>暂无话题。</p>';
  const idxHtml = idxTpl
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SITE_URL}}', esc(SITE.url))
    .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
    .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer))
    .replaceAll('{{TOPICS_LIST}}', topicsListHtml)
    .replaceAll('{{BUILD_TIME}}', esc(BUILD_TIME));
  mkdirSync(join(DIST, 'topics'), { recursive: true });
  writeFileSync(join(DIST, 'topics', 'index.html'), idxHtml);
  topicUrls.push({ loc: SITE.url + '/topics/', lastmod: '' });
  console.log(`话题页渲染完成：${sortedTopics.length} 个话题`);
  return topicUrls;
}

function renderCorrections(today) {
  // 更正记录页（2026-10-07）：data/corrections.json -> /corrections/
  let list = [];
  try { list = JSON.parse(readFileSync(join(DATA_DIR, 'corrections.json'), 'utf8')); } catch (e) { list = []; }
  const body = list.length
    ? list.slice().reverse().map((c) =>
        `<div class="card"><div class="cdate">${esc(c.date || '')}</div>` +
        `<div class="citem">${esc(c.item || '')}</div>` +
        `<div class="cfix">更正：${esc(c.change || '')}</div>` +
        (c.reason ? `<div class="creason">原因：${esc(c.reason)}</div>` : '') +
        `</div>`
      ).join('\n')
    : `<div class="empty">暂无更正记录——我们会把每一次更正都记在这里。</div>`;
  const tpl = readFileSync(join(PIPELINE_DIR, 'corrections-template.html'), 'utf8');
  const html = tpl
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SITE_URL}}', esc(SITE.url))
    .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
    .replaceAll('{{CORRECTIONS}}', body);
  mkdirSync(join(DIST, 'corrections'), { recursive: true });
  writeFileSync(join(DIST, 'corrections', 'index.html'), html);
  return [{ loc: SITE.url + '/corrections/', lastmod: today }];
}

function renderSitemap(urls) {
  const uniq = [...new Map(urls.map((u) => [u.loc, u])).values()];
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    uniq
      .map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`)
      .join('\n') +
    `\n</urlset>\n`;
  writeFileSync(join(DIST, 'sitemap.xml'), xml);
  writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE.url}/sitemap.xml\n`);
  console.log(`sitemap 已生成：${uniq.length} 个 URL`);
}

// Telegram 内联搜索索引：全部期数（归档+RSS 内容）的标题+摘要+链接

function renderSearchIndex(dates) {
  const idx = [];
  for (const d of dates) {
    const ed = loadEdition(d);
    if (!ed) continue;
    for (const sec of ed.sections || []) {
      if (sec.hidden || sec.empty) continue;
      const dDate = sec.detailDate || d;
      const push = (entry, i) => {
        if (!entry || !entry.title) return;
        idx.push({
          t: entry.title,
          s: (entry.summary || entry.blurb || '').slice(0, 160),
          u: `${SITE.url}/detail/${dDate}/${sec.id}-${i}/`,
          d: dDate,
          sec: sec.name,
          hot: !!entry.hot,
        });
      };
      if (sec.headline) push(sec.headline, 0);
      (sec.items || []).forEach((it, i) => push(it, i + 1));
    }
  }
  writeFileSync(join(DIST, 'tg-search-index.json'), JSON.stringify(idx));
  console.log(`搜索索引已生成：${idx.length} 条`);
}

async function renderAll({ today } = {}) {
  await preloadImgDims();
  const dates = listEditions();
  if (!dates.length) {
    console.log('没有可用期数，跳过渲染');
    return;
  }
  assertNoChainedDetailDate(dates);
  const allDates = [...dates].sort().reverse();
  const tpl = readFileSync(join(PIPELINE_DIR, 'template.html'), 'utf8');
  const archiveDir = join(DIST, 'archive');
  mkdirSync(DIST, { recursive: true });
  // 静态资源：public/ → dist/（.b64 图片解码为 webp，.b64 字体解码为 woff2）
  const pubDir = join(ROOT, 'public');
  if (existsSync(pubDir)) cpSync(pubDir, DIST, { recursive: true });
  const distImgDir = join(DIST, 'images');
  if (existsSync(IMG_DIR)) {
    mkdirSync(distImgDir, { recursive: true });
    for (const f of readdirSync(IMG_DIR)) {
      if (!f.endsWith('.webp.b64')) continue;
      const webpName = f.slice(0, -4);
      try {
        const buf = Buffer.from(readFileSync(join(IMG_DIR, f), 'utf8'), 'base64');
        // 简单校验：webp 魔数 RIFF....WEBP
        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) {
          writeFileSync(join(distImgDir, webpName), buf);
        }
      } catch {}
    }
  }
  // 自托管字体：public/fonts/*.woff2.b64 → dist/fonts/*.woff2（WOFF2 魔数 wOF2）
  const fontDir = join(ROOT, 'public', 'fonts');
  if (existsSync(fontDir)) {
    mkdirSync(join(DIST, 'fonts'), { recursive: true });
    for (const f of readdirSync(fontDir)) {
      if (!f.endsWith('.woff2.b64')) continue;
      try {
        const buf = Buffer.from(readFileSync(join(fontDir, f), 'utf8'), 'base64');
        if (buf[0] === 0x77 && buf[1] === 0x4f && buf[2] === 0x46 && buf[3] === 0x32) {
          writeFileSync(join(DIST, 'fonts', f.slice(0, -4)), buf);
        }
      } catch {}
    }
  }
  const latest = dates[dates.length - 1];
  const sitemapUrls = [
    { loc: SITE.url + '/', lastmod: latest },
    { loc: SITE.url + '/archive/', lastmod: latest },
    { loc: SITE.url + '/feed.xml', lastmod: latest },
  ];
  for (const d of dates) {
    const ed = loadEdition(d);
    if (!ed) continue;
    mkdirSync(join(archiveDir, d), { recursive: true });
    // 归档页 canonical 指向自身，避免搜索引擎合并到首页
    const archHtml = renderPage(tpl, ed, allDates, `${SITE.url}/archive/${d}/`, false);
    writeFileSync(join(archiveDir, d, 'index.html'), archHtml);
    if (d === latest) {
      const homeHtml = renderPage(tpl, ed, allDates, SITE.url + '/', FEATURES.telegram.enabled);
      writeFileSync(join(DIST, 'index.html'), homeHtml);
    }
    sitemapUrls.push({ loc: `${SITE.url}/archive/${d}/`, lastmod: d });
  }
  renderArchiveIndex(allDates);
  const detailUrls = renderDetailPages(dates);
  const latestEd = loadEdition(latest);
  if (latestEd) renderFeedXml(latestEd);
  // 关于页
  const aboutTpl = readFileSync(join(PIPELINE_DIR, 'about-template.html'), 'utf8');
  const principlesList = principlesAboutHtml(EDITORIAL.principles);
  const aboutTplPrinciples = principlesList
    ? aboutTpl
    : aboutTpl.replace(/\s*<h2>编辑原则<\/h2>\s*<div class="card">\s*<ul>\s*\{\{PRINCIPLES_LIST\}\}\s*<\/ul>\s*<\/div>/, '');
  const aboutHtml = aboutTplPrinciples
    .replaceAll('{{PRINCIPLES_LIST}}', principlesList)
    .replaceAll('{{SITE_NAME}}', esc(SITE.name))
    .replaceAll('{{SITE_URL}}', esc(SITE.url))
    .replaceAll('{{TAGLINE}}', esc(SITE.tagline))
    .replaceAll('{{DISCLAIMER}}', esc(SITE.disclaimer))
    .replaceAll('{{CONTACT_EMAIL_LINE}}', SITE.contactEmail
      ? `<li>邮件：<a href="mailto:${esc(SITE.contactEmail)}">${esc(SITE.contactEmail)}</a></li>` : '')
    .replaceAll('{{TG_CHANNEL_LINE}}', (FEATURES.telegram.enabled && FEATURES.telegram.channel)
      ? `<li>Telegram 频道：<a href="https://t.me/${esc(FEATURES.telegram.channel)}" target="_blank" rel="noopener">@${esc(FEATURES.telegram.channel)}</a>（每日头条推送）</li>` : '');
  mkdirSync(join(DIST, 'about'), { recursive: true });
  writeFileSync(join(DIST, 'about', 'index.html'), aboutHtml);
  sitemapUrls.push({ loc: SITE.url + '/about/', lastmod: latest });
  const topicUrls = renderTopicPages(dates);
  const correctionUrls = renderCorrections(today);
  renderSitemap([...sitemapUrls, ...detailUrls, ...topicUrls, ...correctionUrls]);
  renderSearchIndex(allDates);
  console.log(`渲染完成：共 ${dates.length} 期，首页 = ${latest}`);
}

export {
  renderAll, renderPage, renderSection, renderDigest, renderDetailPages,
  renderFeedXml, renderArchiveIndex, renderTopicPages, renderCorrections,
  renderSitemap, renderSearchIndex, assertNoChainedDetailDate,
  sourceLine, trustBadges, hotMark, extractKeywords, findRelated,
};
