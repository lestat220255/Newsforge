// 全文抓取助手：node pipeline/fetch-text.js <url>
// 输出文章正文纯文本（去标签、去脚本样式），供编辑写摘要前阅读
import { sniffCharset, decodeBody } from './lib/utils.js';

const url = process.argv[2];
if (!url) {
  console.error('用法: node pipeline/fetch-text.js <url>');
  process.exit(1);
}

async function main() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(t);
    if (!res.ok) {
      console.error(`HTTP ${res.status}`);
      process.exit(2);
    }
    // 响应体上限 5MB（与 run.js fetchText 一致）：无 Content-Length 时边读边限流
    const MAX_BODY = 5 * 1024 * 1024;
    const len = res.headers.get('content-length');
    if (len && +len > MAX_BODY) {
      console.error(`响应体过大 (${len} bytes)`);
      process.exit(2);
    }
    const chunks = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY) {
        reader.cancel();
        console.error(`响应体过大 (>${MAX_BODY} bytes)`);
        process.exit(2);
      }
      chunks.push(value);
    }
    let buf = Buffer.concat(chunks);
    // 编码嗅探：与 run.js fetchText 共用 lib/utils.js 的实现
    const charset = sniffCharset(buf, res.headers.get('content-type'));
    let html = decodeBody(buf, charset);
    // 去掉 script/style/nav/header/footer/aside
    html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    html = html.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    html = html.replace(/<(nav|header|footer|aside|form|noscript)[\s\S]*?<\/\1>/gi, ' ');
    // 取 article/main 标签内容（如果有）
    const m = html.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
    if (m) html = m[2];
    // 去标签
    let text = html.replace(/<[^>]+>/g, ' ');
    // HTML 实体
    text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'").replace(/&rdquo;/g, '"')
      .replace(/&ldquo;/g, '"').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–');
    // 压缩空白
    text = text.replace(/\s+/g, ' ').trim();
    // 截断到 12000 字符（约够写摘要）
    if (text.length > 12000) text = text.slice(0, 12000) + '…[截断]';
    console.log(text);
  } catch (e) {
    console.error(`抓取失败: ${e.message}`);
    process.exit(2);
  }
}
main();
