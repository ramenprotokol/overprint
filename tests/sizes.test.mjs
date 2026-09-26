// Size maths shared by the page and the README.
// Export: each dot becomes a k × k block of whole pixels (nearest-neighbour),
// with k chosen so the long edge is at least 2400 px. The page shows exactly
// these numbers next to the Export button, and the README quotes them.
// Preview: each dot covers a whole number of device pixels whenever that
// still fills most of the space, so the grain stays crisp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOT_SIZES, EXPORT_MIN_EDGE, exportSize, fitPreview } from '../web/params.js';

test('the dot sizes and the export target are the ones the README quotes', () => {
  assert.deepEqual(DOT_SIZES, [400, 600, 900]);
  assert.equal(EXPORT_MIN_EDGE, 2400);
});

test('landscape prints: 2400 px at 400 and 600 dots, 2700 px at 900', () => {
  assert.deepEqual(exportSize(400, 267), { k: 6, width: 2400, height: 1602 });
  assert.deepEqual(exportSize(600, 400), { k: 4, width: 2400, height: 1600 });
  assert.deepEqual(exportSize(900, 600), { k: 3, width: 2700, height: 1800 });
  assert.deepEqual(exportSize(900, 675), { k: 3, width: 2700, height: 2025 });
});

test('portrait prints use the long edge too', () => {
  assert.deepEqual(exportSize(300, 400), { k: 6, width: 1800, height: 2400 });
  assert.deepEqual(exportSize(600, 900), { k: 3, width: 1800, height: 2700 });
});

test('the long edge is never below 2400 px and k is always a whole number ≥ 1', () => {
  for (const long of [1, 2, 7, 399, 400, 401, 599, 600, 799, 800, 801, 899, 900, 2400, 5000]) {
    const { k, width, height } = exportSize(long, Math.max(1, long >> 1));
    assert.ok(Number.isInteger(k) && k >= 1, `k=${k} for ${long}`);
    assert.equal(width, long * k);
    if (long <= 2400) assert.ok(width >= 2400, `${long} dots → ${width} px`);
    if (k > 1) assert.ok(long * (k - 1) < 2400, `${long}: k=${k} is bigger than needed`);
  }
  assert.deepEqual(exportSize(0, 0), { k: 1, width: 0, height: 0 });
});

const fits = (f, bw, bh) => f.iw + 2 * f.m <= bw + 1e-9 && f.ih + 2 * f.m <= bh + 1e-9;

test('preview: a 1280 × 800 desktop shows 400 dots at exactly 2 device pixels per dot', () => {
  const f = fitPreview(856, 672, 400, 267, 1);
  assert.equal(f.whole, true);
  assert.equal(f.perDot, 2);
  assert.equal(f.iw, 800);
  assert.equal(f.ih, 534);
  assert.ok(f.m >= 14 && f.m <= 52, `margin ${f.m}`);
  assert.ok(fits(f, 856, 672));
});

test('preview: whole device pixels at any pixel ratio when there is room', () => {
  for (const [dpr, k] of [[2, 4], [1.5, 3], [1.25, 2], [3, 6]]) {
    const f = fitPreview(856, 672, 400, 267, dpr);
    assert.equal(f.whole, true, `dpr ${dpr}`);
    assert.equal(f.perDot, k, `dpr ${dpr}`);
    assert.ok(Math.abs(f.iw * dpr - 400 * k) < 1e-9, `dpr ${dpr}: ${f.iw} css px`);
    assert.ok(fits(f, 856, 672), `dpr ${dpr}`);
  }
});

test('preview: a dpr-3 phone snaps; a dpr-2 phone keeps the print big instead of halving it', () => {
  const p3 = fitPreview(368, 670, 400, 267, 3);
  assert.equal(p3.whole, true);
  assert.equal(p3.perDot, 2);
  assert.ok(fits(p3, 368, 670));
  const p2 = fitPreview(368, 670, 400, 267, 2);
  assert.equal(p2.whole, false, 'one device pixel per dot would show the print at 200 of 368 px');
  assert.ok(p2.iw > 300, `iw ${p2.iw}`);
  assert.ok(fits(p2, 368, 670));
});

test('preview: 900 dots on a small screen scale down smoothly and still fit', () => {
  const f = fitPreview(856, 672, 900, 600, 1);
  assert.equal(f.whole, false);
  assert.ok(f.perDot < 1);
  assert.ok(fits(f, 856, 672));
});

test('preview: the sheet always fits the bed', () => {
  for (const bw of [200, 368, 500, 856, 1500]) {
    for (const bh of [300, 670, 900]) {
      for (const [w, h] of [[400, 267], [267, 400], [600, 600], [900, 300]]) {
        for (const dpr of [1, 1.5, 2, 3]) {
          const f = fitPreview(bw, bh, w, h, dpr);
          assert.ok(fits(f, bw, bh) || f.iw <= 40 || f.ih <= 30, `${bw}×${bh} ${w}×${h} @${dpr}`);
          if (f.whole) assert.ok(Number.isInteger(f.perDot) && f.perDot >= 1);
        }
      }
    }
  }
});
