// lib/utils.js 单元测试：node --test pipeline/lib/
// 覆盖曾出过真实 bug 的纯函数（时区、转义、编码嗅探），全部确定性断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  esc, isSafeUrl, toISO, parseTime, fmtDate, tzOffsetAt,
  isFresh, isStale, sniffCharset, decodeBody, shortHash, headersFor,
} from './utils.js';

test('esc 转义 HTML 特殊字符', () => {
  assert.equal(esc('<a href="x">\'&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(123), '123');
});

test('isSafeUrl 只接受 http/https', () => {
  assert.equal(isSafeUrl('https://example.com/a'), true);
  assert.equal(isSafeUrl('http://example.com'), true);
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
  assert.equal(isSafeUrl('data:text/html,hi'), false);
  assert.equal(isSafeUrl('/relative/path'), false);
  assert.equal(isSafeUrl(''), false);
  assert.equal(isSafeUrl(null), false);
});

test('toISO 解析与非法输入', () => {
  assert.ok(toISO('2026-10-10T12:00:00+08:00').startsWith('2026-10-10T04:00:00.000Z'));
  assert.equal(toISO('not a date'), null);
  assert.equal(toISO(''), null);
});

test('parseTime 带时区字符串精确解析', () => {
  assert.equal(parseTime('2026-01-15T12:00:00Z'), Date.UTC(2026, 0, 15, 12, 0, 0));
  assert.equal(parseTime('2026-01-15T12:00:00+08:00'), Date.UTC(2026, 0, 15, 4, 0, 0));
  assert.ok(Number.isNaN(parseTime('')));
  assert.ok(Number.isNaN(parseTime(null)));
});

test('parseTime 无时区字符串按配置时区解析（site.json.example=Asia/Shanghai）', () => {
  // 上海 12:00 = UTC 04:00
  assert.equal(parseTime('2026-01-15T12:00:00'), Date.UTC(2026, 0, 15, 4, 0, 0));
  // fmtDate 往返一致
  assert.equal(fmtDate('2026-01-15T12:00:00'), '2026-01-15');
  assert.equal(fmtDate('2026-01-15T23:30:00'), '2026-01-15');
});

test('tzOffsetAt 各时区偏移正确', () => {
  const jan = Date.UTC(2026, 0, 15, 12);
  const jul = Date.UTC(2026, 6, 15, 12);
  assert.equal(tzOffsetAt('Asia/Shanghai', jan), 8 * 3600 * 1000);
  assert.equal(tzOffsetAt('America/New_York', jan), -5 * 3600 * 1000); // 冬令时
  assert.equal(tzOffsetAt('America/New_York', jul), -4 * 3600 * 1000); // 夏令时
  assert.equal(tzOffsetAt('Europe/London', jan), 0);
  // 非法时区名回退北京时间（+8），不抛异常
  assert.equal(tzOffsetAt('Not/AZone', jan), 8 * 3600 * 1000);
});

test('isFresh / isStale 新鲜度窗口', () => {
  const h = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString();
  assert.equal(isFresh(h(1)), true);
  assert.equal(isFresh(h(40)), false); // 36h 窗口
  assert.equal(isFresh(null), false);
  assert.equal(isStale(h(24 * 8)), true); // 7 天
  assert.equal(isStale(h(24)), false);
});

test('sniffCharset 编码嗅探', () => {
  assert.equal(sniffCharset(Buffer.alloc(0), 'text/html; charset=gbk'), 'gbk');
  assert.equal(sniffCharset(Buffer.alloc(0), 'text/html; charset=UTF-8'), 'utf-8');
  const gbkMeta = Buffer.from('<html><head><meta charset="gb2312"></head>', 'latin1');
  assert.equal(sniffCharset(gbkMeta, 'text/html'), 'gb2312');
  assert.equal(sniffCharset(Buffer.from('<html></html>'), 'text/html'), 'utf-8');
});

test('decodeBody GBK 解码', () => {
  const buf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // "中文" 的 GBK
  assert.equal(decodeBody(buf, 'gbk'), '中文');
  assert.equal(decodeBody(Buffer.from('hello'), 'utf-8'), 'hello');
});

test('shortHash 确定性', () => {
  assert.equal(shortHash('abc'), shortHash('abc'));
  assert.notEqual(shortHash('abc'), shortHash('abd'));
  assert.match(shortHash('abc'), /^[0-9a-f]{1,8}$/);
});

test('headersFor 按域名切换 UA', () => {
  assert.match(headersFor('https://www.cbc.ca/news')['User-Agent'], /Mozilla/);
  assert.match(headersFor('https://example.com/rss')['User-Agent'], /NewsforgeBot/);
});
