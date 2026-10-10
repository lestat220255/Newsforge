// Newsforge R2 模块纯函数测试：r2Key（按月分文件夹）、walkImages（edition 图片遍历改写）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { r2Key, walkImages } from './r2-images.js';

test('r2Key 按日期生成月份前缀', () => {
  assert.equal(r2Key('2026-10-10', '2026-10-10-tech-0.webp'), '2026-10/2026-10-10-tech-0.webp');
  assert.equal(r2Key('2026-01-05', 'a.webp'), '2026-01/a.webp');
});

test('r2Key 非日期回退 misc', () => {
  assert.equal(r2Key('nodate', 'x.webp'), 'misc/x.webp');
  assert.equal(r2Key('', 'x.webp'), 'misc/x.webp');
});

test('walkImages 只改写 fn 返回新值的字段', () => {
  const ed = {
    sections: [
      {
        headline: { image: '/images/2026-10-10-tech-0.webp' },
        items: [{ image: '/images/2026-10-10-tech-s0.webp' }, { title: '无图' }],
      },
      { headline: { title: '无图头条' }, items: [] },
    ],
  };
  const n = walkImages(ed, (img) =>
    img.startsWith('/images/') ? 'https://cdn.example.com/2026-10/' + img.split('/').pop() : undefined,
  );
  assert.equal(n, 2);
  assert.equal(ed.sections[0].headline.image, 'https://cdn.example.com/2026-10/2026-10-10-tech-0.webp');
  assert.equal(ed.sections[0].items[0].image, 'https://cdn.example.com/2026-10/2026-10-10-tech-s0.webp');
  assert.equal(ed.sections[0].items[1].image, undefined);
});

test('walkImages fn 返回 undefined 时不改写', () => {
  const ed = { sections: [{ headline: { image: 'https://cdn.example.com/2026-10/a.webp' }, items: [] }] };
  const n = walkImages(ed, () => undefined);
  assert.equal(n, 0);
  assert.equal(ed.sections[0].headline.image, 'https://cdn.example.com/2026-10/a.webp');
});

test('walkImages 空 edition 不崩', () => {
  assert.equal(walkImages({}, () => 'x'), 0);
  assert.equal(walkImages({ sections: [] }, () => 'x'), 0);
});
