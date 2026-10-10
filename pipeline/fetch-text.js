// 全文抓取助手：node pipeline/fetch-text.js <url>
// 输出文章正文纯文本（去标签、去脚本样式），供编辑写摘要前阅读
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
    let buf = Buffer.from(await res.arrayBuffer());
    // 编码嗅探（2026-10-09）：部分中文站（汽车之家/车质网）用 GBK，res.text() 默认 UTF-8 会乱码
    let charset = 'utf-8';
    const ct = res.headers.get('content-type') || '';
    const cm = ct.match(/charset=([\w-]+)/i);
    if (cm) charset = cm[1].toLowerCase();
    else {
      const head = buf.subarray(0, 4096).toString('latin1');
      const m2 = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
      if (m2) charset = m2[1].toLowerCase();
    }
    let html = (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030')
      ? new TextDecoder('gb18030').decode(buf)
      : buf.toString('utf8');
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
