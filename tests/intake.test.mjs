// Checks that run on a dropped or chosen file before (and just after) the
// browser decodes it: format sniffing, the SVG message, the pixel cap and
// the size of the one working copy the page keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PIXELS,
  WORK_EDGE,
  sniffImage,
  precheck,
  pixelProblem,
  decodeFailure,
  workingSize,
} from '../web/intake.js';

const utf8 = new TextEncoder();
const bytes = (...parts) => {
  const out = [];
  for (const p of parts) out.push(...(typeof p === 'string' ? utf8.encode(p) : p));
  return Uint8Array.from(out);
};
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const be16 = (v) => [(v >>> 8) & 255, v & 255];
const le16 = (v) => [v & 255, (v >>> 8) & 255];
const le24 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255];

const png = (w, h) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0]);
const gif = (w, h) => bytes('GIF89a', le16(w), le16(h), [0, 0, 0]);
const jpeg = (w, h, appBytes = 14) =>
  bytes([0xff, 0xd8], [0xff, 0xe1], be16(appBytes + 2), new Array(appBytes).fill(0x41), [0xff, 0xdb], be16(4), [0, 0],
    [0xff, 0xc2], be16(11), [8], be16(h), be16(w), [1, 1, 0x11, 0]);
const webpX = (w, h) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [0, 0, 0, 0], le24(w - 1), le24(h - 1));
const webpLossy = (w, h) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ', [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(w), le16(h));
const webpLossless = (w, h) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8L', [0, 0, 0, 0], [0x2f], [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
};
const heic = () => bytes([0, 0, 0, 24], 'ftyp', 'heic', [0, 0, 0, 0], 'mif1heic');
const bmp = (w, h) => bytes('BM', new Array(16).fill(0), [w & 255, (w >>> 8) & 255, 0, 0], [(-h) & 255, ((-h) >>> 8) & 255, 255, 255]);
const svg = (prefix = '') => bytes(`${prefix}<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`);

test('sniffs the dimensions of PNG, GIF, JPEG and all three WebP flavours', () => {
  assert.deepEqual(sniffImage(png(4032, 3024)), { format: 'png', width: 4032, height: 3024 });
  assert.deepEqual(sniffImage(gif(320, 200)), { format: 'gif', width: 320, height: 200 });
  assert.deepEqual(sniffImage(jpeg(6000, 4000)), { format: 'jpeg', width: 6000, height: 4000 });
  assert.deepEqual(sniffImage(jpeg(1200, 900, 5000)), { format: 'jpeg', width: 1200, height: 900 }, 'skips a large APP segment');
  assert.deepEqual(sniffImage(webpX(16383, 9000)), { format: 'webp', width: 16383, height: 9000 });
  assert.deepEqual(sniffImage(webpLossy(1024, 768)), { format: 'webp', width: 1024, height: 768 });
  assert.deepEqual(sniffImage(webpLossless(777, 555)), { format: 'webp', width: 777, height: 555 });
  assert.deepEqual(sniffImage(bmp(640, 480)), { format: 'bmp', width: 640, height: 480 }, 'top-down BMP');
});

test('recognises SVG (with or without an XML prolog, BOM or comment) and HEIC', () => {
  assert.equal(sniffImage(svg()).format, 'svg');
  assert.equal(sniffImage(svg('﻿<?xml version="1.0"?>\n<!-- drawn by hand -->\n')).format, 'svg');
  assert.equal(sniffImage(svg('  \n')).format, 'svg');
  assert.equal(sniffImage(heic()).format, 'heic');
  assert.equal(sniffImage(bytes('<html><body>not an svg</body></html>')).format, 'unknown');
});

test('never throws on truncated or random bytes', () => {
  assert.deepEqual(sniffImage(new Uint8Array(0)), { format: 'unknown', width: null, height: null });
  const full = [png(10, 10), gif(10, 10), jpeg(10, 10), webpX(10, 10), webpLossy(10, 10), webpLossless(10, 10)];
  for (const b of full) {
    for (let n = 0; n < b.length; n++) {
      const r = sniffImage(b.subarray(0, n));
      assert.ok(r.width === null || Number.isInteger(r.width));
    }
  }
  let seed = 7;
  for (let i = 0; i < 500; i++) {
    const b = new Uint8Array(i % 64);
    for (let j = 0; j < b.length; j++) b[j] = (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
    if (i % 5 === 0 && b.length > 2) b.set([0xff, 0xd8], 0); // random JPEG-looking junk
    sniffImage(b);
  }
});

test('an SVG gets a clear “not supported, use a photo” message, however it arrives', () => {
  const cases = [
    [{ name: 'logo.svg', type: 'image/svg+xml', size: 90 }, svg()],
    [{ name: 'logo.SVG', type: '', size: 90 }, svg()],
    [{ name: 'drawing', type: '', size: 90 }, svg('<?xml version="1.0"?>')],
  ];
  for (const [file, head] of cases) {
    const msg = precheck(file, head);
    assert.ok(msg, `${file.name} should be refused`);
    assert.match(msg, /SVG/);
    assert.match(msg, /isn’t supported/);
    assert.match(msg, /photo \(JPEG, PNG or WebP\)/);
    assert.doesNotMatch(msg, /HEIC|damaged/);
  }
});

test('refuses anything over the pixel cap before decoding, with the numbers in the message', () => {
  assert.equal(MAX_PIXELS, 100_000_000);
  const huge = precheck({ name: 'scan.png', type: 'image/png', size: 5_000_000 }, png(20000, 10000));
  assert.match(huge, /20,000 × 10,000 px/);
  assert.match(huge, /200 megapixels/);
  assert.match(huge, /up to 100 megapixels/);
  assert.equal(precheck({ name: 'ok.png', type: 'image/png', size: 5_000_000 }, png(10000, 10000)), null, 'exactly 100 MP is fine');
  assert.ok(precheck({ name: 'big.png', type: 'image/png', size: 5_000_000 }, png(10001, 10000)));
  assert.ok(precheck({ name: 'big.webp', type: 'image/webp', size: 5_000_000 }, webpX(16383, 16383)));
  // Dimensions unknown before decoding: let the browser try; pixelProblem() checks again afterwards.
  assert.equal(precheck({ name: 'odd.jpg', type: 'image/jpeg', size: 10 }, bytes([0xff, 0xd8, 0xff])), null);
});

test('pixelProblem() is the same cap, used again after decoding', () => {
  assert.equal(pixelProblem('a.jpg', 4032, 3024), null);
  assert.match(pixelProblem('a.jpg', 12000, 9000), /108 megapixels/);
  assert.match(pixelProblem('a.jpg', 0, 10), /no pixels/);
});

test('the other refusals keep their plain-English messages', () => {
  assert.match(precheck({ name: 'notes.txt', type: 'text/plain', size: 5 }, bytes('hello')), /isn’t an image/);
  assert.match(precheck({ name: 'huge.jpg', type: 'image/jpeg', size: 81 * 1024 * 1024 }, jpeg(10, 10)), /over 80 MB/);
  assert.match(precheck({ name: 'empty.png', type: 'image/png', size: 40 }, png(0, 0)), /no pixels/);
  assert.equal(precheck({ name: 'photo.jpg', type: 'image/jpeg', size: 2e6 }, jpeg(4032, 3024)), null);
});

test('decode failures name HEIC only when the file really is HEIC', () => {
  assert.match(decodeFailure('IMG_0001.HEIC', 'heic'), /HEIC/);
  const generic = decodeFailure('broken.png', 'png');
  assert.match(generic, /couldn’t open “broken\.png”/);
  assert.doesNotMatch(generic, /HEIC/);
});

test('long names are shortened in messages', () => {
  const name = 'a'.repeat(80) + '.svg';
  assert.match(precheck({ name, type: 'image/svg+xml', size: 1 }, svg()), /a{36}…/);
});

test('the working copy is at most WORK_EDGE on its long edge and never upscaled', () => {
  assert.equal(WORK_EDGE, 900);
  assert.deepEqual(workingSize(4032, 3024), { width: 900, height: 675 });
  assert.deepEqual(workingSize(3024, 4032), { width: 675, height: 900 });
  assert.deepEqual(workingSize(640, 480), { width: 640, height: 480 });
  assert.deepEqual(workingSize(900, 900), { width: 900, height: 900 });
  assert.deepEqual(workingSize(100000, 3), { width: 900, height: 1 });
});
