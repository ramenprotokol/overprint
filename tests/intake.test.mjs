// Checks that run on a dropped or chosen file before (and just after) the
// browser decodes it: format sniffing, the SVG message, the pixel cap, files
// crafted to hide their real size from the check, and the size of the one
// working copy the page keeps. Every test image is built here, byte by byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as intake from '../web/intake.js';

const { MAX_PIXELS, WORK_EDGE, HEAD_BYTES, sniffImage, precheck, pixelProblem, decodeFailure, workingSize } = intake;

const utf8 = new TextEncoder();
const bytes = (...parts) => {
  const chunks = parts.map((p) => (typeof p === 'string' ? utf8.encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};
const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const be16 = (v) => [(v >>> 8) & 255, v & 255];
const le16 = (v) => [v & 255, (v >>> 8) & 255];
const le24 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255];

const png = (w, h) => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0]);
const jpeg = (w, h, appBytes = 14) =>
  bytes([0xff, 0xd8], [0xff, 0xe1], be16(appBytes + 2), new Array(appBytes).fill(0x41), [0xff, 0xdb], be16(4), [0, 0],
    [0xff, 0xc2], be16(11), [8], be16(h), be16(w), [1, 1, 0x11, 0]);
const webpX = (w, h) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8X', [10, 0, 0, 0], [0, 0, 0, 0], le24(w - 1), le24(h - 1));
const webpLossy = (w, h) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8 ', [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(w), le16(h));
const webpLossless = (w, h) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return bytes('RIFF', [0, 0, 0, 0], 'WEBP', 'VP8L', [0, 0, 0, 0], [0x2f], [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
};
const bmp = (w, h) => bytes('BM', new Array(16).fill(0), [w & 255, (w >>> 8) & 255, 0, 0], [(-h) & 255, ((-h) >>> 8) & 255, 255, 255]);
const svg = (prefix = '') => bytes(`${prefix}<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`);

// ---- GIF: header, logical screen, optional global colour table, then blocks.
const subBlocks = (n) => {
  // n bytes of extension data as 255-byte sub-blocks, then the empty terminator
  const out = [];
  for (let left = n; left > 0; left -= 255) {
    const k = Math.min(255, left);
    out.push(k, ...new Array(k).fill(0x20));
  }
  return [...out, 0];
};
const gifFrame = ({ left = 0, top = 0, w, h }) => [0x2c, ...le16(left), ...le16(top), ...le16(w), ...le16(h), 0, 2, 2, 0x4c, 0x01, 0];
function gif(sw, sh, { frame = { w: sw, h: sh }, gct = false, comment = 0 } = {}) {
  return bytes('GIF89a', le16(sw), le16(sh), [gct ? 0xf7 : 0, 0, 0], gct ? new Array(768).fill(0) : [],
    [0x21, 0xff, 11], 'NETSCAPE2.0', [3, 1, 0, 0, 0], // looping application extension
    [0x21, 0xf9, 4, 0, 0, 0, 0, 0], // graphic control extension
    comment ? [0x21, 0xfe, ...subBlocks(comment)] : [], // comment extension
    gifFrame(frame), [0x3b]);
}

// ---- JPEG: marker segments before the frame header.
const app15 = (n) => [0xff, 0xef, ...be16(n + 2), ...new Array(n).fill(0)];
const sof0 = (w, h) => [0xff, 0xc0, ...be16(11), 8, ...be16(h), ...be16(w), 1, 1, 0x11, 0];
const jpegWith = (...segments) => bytes([0xff, 0xd8], ...segments, [0xff, 0xd9]);

// ---- ISOBMFF (AVIF / HEIC): ftyp, then meta > iprp > ipco > ispe.
const box = (type, ...body) => {
  const b = bytes(...body);
  return bytes(be32(8 + b.length), type, b);
};
const fullBox = (type, ...body) => box(type, [0, 0, 0, 0], ...body);
const ftyp = (major, ...compatible) => box('ftyp', major, [0, 0, 0, 0], ...compatible);
const ispe = (w, h) => fullBox('ispe', be32(w), be32(h));
const meta = (...properties) =>
  fullBox('meta',
    fullBox('hdlr', [0, 0, 0, 0], 'pict', new Array(12).fill(0), [0]),
    fullBox('pitm', be16(1)),
    box('iprp', box('ipco', ...properties), fullBox('ipma', be32(1), be16(1), [1, 0x81]))); // item 1 -> property 1, essential
const av1C = () => box('av1C', [0x81, 0x00, 0x0c, 0x00]);
const mdat = (n) => box('mdat', new Array(n).fill(0));

/** A File, as the page gets it from a drop or the file picker. */
const asFile = (b, name, type) => new File([b], name, { type });

/** A file-like object whose bytes are made on demand, and which counts reads. */
function virtualFile(size, byteAt) {
  const log = { reads: 0, bytes: 0 };
  return {
    log,
    size,
    slice(a, z) {
      const from = Math.max(0, a);
      const n = Math.max(0, Math.min(size, z) - from);
      log.reads++;
      log.bytes += n;
      return {
        async arrayBuffer() {
          const out = new Uint8Array(n);
          for (let i = 0; i < n; i++) out[i] = byteAt(from + i);
          return out.buffer;
        },
      };
    },
  };
}
const counted = (b) => virtualFile(b.length, (i) => b[i]);

test('sniffs the dimensions of PNG, GIF, JPEG and all three WebP flavours', async () => {
  assert.deepEqual(await sniffImage(png(4032, 3024)), { format: 'png', width: 4032, height: 3024 });
  assert.deepEqual(await sniffImage(gif(320, 200)), { format: 'gif', width: 320, height: 200 });
  assert.deepEqual(await sniffImage(gif(320, 200, { gct: true })), { format: 'gif', width: 320, height: 200 }, 'skips a global colour table');
  assert.deepEqual(await sniffImage(jpeg(6000, 4000)), { format: 'jpeg', width: 6000, height: 4000 });
  assert.deepEqual(await sniffImage(jpeg(1200, 900, 5000)), { format: 'jpeg', width: 1200, height: 900 }, 'skips a large APP segment');
  assert.deepEqual(await sniffImage(webpX(16383, 9000)), { format: 'webp', width: 16383, height: 9000 });
  assert.deepEqual(await sniffImage(webpLossy(1024, 768)), { format: 'webp', width: 1024, height: 768 });
  assert.deepEqual(await sniffImage(webpLossless(777, 555)), { format: 'webp', width: 777, height: 555 });
  assert.deepEqual(await sniffImage(bmp(640, 480)), { format: 'bmp', width: 640, height: 480 }, 'top-down BMP');
});

test('recognises SVG (with or without an XML prolog, BOM or comment), HEIC and AVIF', async () => {
  assert.equal((await sniffImage(svg())).format, 'svg');
  assert.equal((await sniffImage(svg('﻿<?xml version="1.0"?>\n<!-- drawn by hand -->\n'))).format, 'svg');
  assert.equal((await sniffImage(svg('  \n'))).format, 'svg');
  assert.equal((await sniffImage(ftyp('heic', 'mif1', 'heic'))).format, 'heic');
  assert.equal((await sniffImage(ftyp('avif', 'mif1', 'miaf'))).format, 'avif');
  assert.equal((await sniffImage(ftyp('mif1', 'avif', 'miaf'))).format, 'avif', 'AVIF named only as a compatible brand');
  assert.equal((await sniffImage(bytes('<html><body>not an svg</body></html>'))).format, 'unknown');
});

test('never throws on truncated or random bytes', async () => {
  assert.deepEqual(await sniffImage(new Uint8Array(0)), { format: 'unknown', width: null, height: null });
  const full = [png(10, 10), gif(10, 10), jpeg(10, 10), webpX(10, 10), webpLossy(10, 10), webpLossless(10, 10),
    bytes(ftyp('avif', 'mif1'), meta(ispe(10, 10), av1C()))];
  for (const b of full) {
    for (let n = 0; n < b.length; n++) {
      const r = await sniffImage(b.subarray(0, n));
      assert.ok(r.width === null || Number.isInteger(r.width));
    }
  }
  let seed = 7;
  for (let i = 0; i < 500; i++) {
    const b = new Uint8Array(i % 64);
    for (let j = 0; j < b.length; j++) b[j] = (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
    if (i % 5 === 0 && b.length > 2) b.set([0xff, 0xd8], 0); // random JPEG-looking junk
    if (i % 5 === 1 && b.length > 6) b.set(utf8.encode('GIF89a'), 0); // random GIF-looking junk
    if (i % 5 === 2 && b.length > 12) b.set(utf8.encode('ftypavif'), 4); // random AVIF-looking junk
    await sniffImage(b);
  }
});

test('an SVG gets a clear “not supported, use a photo” message, however it arrives', async () => {
  const cases = [
    [{ name: 'logo.svg', type: 'image/svg+xml', size: 90 }, svg()],
    [{ name: 'logo.SVG', type: '', size: 90 }, svg()],
    [{ name: 'drawing', type: '', size: 90 }, svg('<?xml version="1.0"?>')],
  ];
  for (const [file, head] of cases) {
    const msg = await precheck(file, head);
    assert.ok(msg, `${file.name} should be refused`);
    assert.match(msg, /SVG/);
    assert.match(msg, /isn’t supported/);
    assert.match(msg, /photo \(JPEG, PNG or WebP\)/);
    assert.doesNotMatch(msg, /HEIC|damaged/);
  }
});

test('refuses anything over the pixel cap before decoding, with the numbers in the message', async () => {
  assert.equal(MAX_PIXELS, 100_000_000);
  const huge = await precheck({ name: 'scan.png', type: 'image/png', size: 5_000_000 }, png(20000, 10000));
  assert.match(huge, /20,000 × 10,000 px/);
  assert.match(huge, /200 megapixels/);
  assert.match(huge, /up to 100 megapixels/);
  assert.equal(await precheck({ name: 'ok.png', type: 'image/png', size: 5_000_000 }, png(10000, 10000)), null, 'exactly 100 MP is fine');
  assert.ok(await precheck({ name: 'big.png', type: 'image/png', size: 5_000_000 }, png(10001, 10000)));
  assert.ok(await precheck({ name: 'big.webp', type: 'image/webp', size: 5_000_000 }, webpX(16383, 16383)));
});

// O-1: files built so that the header the old check read says "small" or
// says nothing, while the browser's decoder would allocate a huge image.

test('GIF: the first frame counts, not just the logical screen (a 1 × 1 screen can hold a 23,000 × 23,000 frame)', async () => {
  const sneaky = gif(1, 1, { frame: { w: 23000, h: 23000 } });
  assert.deepEqual(await sniffImage(sneaky), { format: 'gif', width: 23000, height: 23000 });
  const offset = gif(100, 100, { frame: { left: 11000, top: 9000, w: 1000, h: 1000 } });
  assert.deepEqual(await sniffImage(offset), { format: 'gif', width: 12000, height: 10000 }, 'a frame placed far off the screen');
  const msg = await precheck(asFile(sneaky, 'tiny.gif', 'image/gif'));
  assert.match(msg, /23,000 × 23,000 px \(529 megapixels\)/);
  // A normal GIF, with a colour table and extensions before its frame, is still fine.
  assert.equal(await precheck(asFile(gif(640, 480, { gct: true, comment: 300 }), 'cat.gif', 'image/gif')), null);
});

test('GIF: extension blocks that push the first frame past the first read are walked', async () => {
  const deep = gif(1, 1, { frame: { w: 23000, h: 23000 }, comment: 300_000 });
  assert.ok(deep.length > HEAD_BYTES);
  assert.deepEqual(await sniffImage(asFile(deep, 'deep.gif', 'image/gif')), { format: 'gif', width: 23000, height: 23000 });
});

test('JPEG: the frame header is found behind 5 × 64 KB of APP15 segments', async () => {
  const hidden = jpegWith(...Array.from({ length: 5 }, () => app15(65533)), sof0(23000, 23000));
  assert.ok(hidden.length > 5 * 65535);
  const file = asFile(hidden, 'hidden.jpg', 'image/jpeg');
  assert.deepEqual(await sniffImage(file), { format: 'jpeg', width: 23000, height: 23000 });
  assert.match(await precheck(file), /23,000 × 23,000 px \(529 megapixels\)/);
});

test('JPEG: the segment walk resyncs the way libjpeg does (junk bytes, 0xFF fill, FF 00)', async () => {
  const messy = jpegWith(app15(100), [0x12, 0x34, 0x56], [0xff, 0x00], [0xff, 0xff, 0xff], app15(10), sof0(20000, 15000));
  assert.deepEqual(await sniffImage(asFile(messy, 'messy.jpg', 'image/jpeg')), { format: 'jpeg', width: 20000, height: 15000 });
});

test('the walk is bounded: a file cannot make the page read on and on', async () => {
  const { MAX_READS, MAX_READ_BYTES } = intake;
  assert.ok(Number.isInteger(MAX_READS) && MAX_READS > 0 && MAX_READS <= 4096);
  assert.ok(MAX_READ_BYTES <= 4 * 1024 * 1024);
  // Just under 80 MB of maximum-size APP15 segments before the frame header:
  // far more hops than the budget allows, so the size is never found and the
  // file is refused. (Made on demand: nothing this big is held in memory.)
  const segments = 1200;
  const tail = [...sof0(1000, 1000), 0xff, 0xd9];
  const size = 2 + segments * 65537 + tail.length;
  assert.ok(size < 80 * 1024 * 1024);
  const file = virtualFile(size, (p) => {
    if (p < 2) return [0xff, 0xd8][p];
    const q = p - 2;
    if (q >= segments * 65537) return tail[q - segments * 65537];
    return [0xff, 0xef, 0xff, 0xff][q % 65537] ?? 0;
  });
  const msg = await precheck({ name: 'endless.jpg', type: 'image/jpeg', size }, file);
  assert.match(msg, /couldn’t find the size/i);
  assert.ok(file.log.reads <= MAX_READS, `${file.log.reads} reads`);
  assert.ok(file.log.bytes <= MAX_READ_BYTES, `${file.log.bytes} bytes read`);
  // An ordinary photo takes a single small read.
  const photo = counted(jpeg(4032, 3024, 30000));
  assert.equal(await precheck({ name: 'photo.jpg', type: 'image/jpeg', size: photo.size }, photo), null);
  assert.equal(photo.log.reads, 1);
});

test('AVIF: the size comes from the ispe box (meta > iprp > ipco > ispe)', async () => {
  const avif = bytes(ftyp('avif', 'mif1', 'miaf'), meta(ispe(12000, 12000), av1C()), mdat(64));
  assert.deepEqual(await sniffImage(avif), { format: 'avif', width: 12000, height: 12000 });
  assert.match(await precheck(asFile(avif, 'small.avif', 'image/avif')), /12,000 × 12,000 px \(144 megapixels\)/);
  assert.equal(await precheck(asFile(bytes(ftyp('avif', 'mif1'), meta(ispe(4032, 3024), av1C())), 'ok.avif', 'image/avif')), null);
  // meta after a large mdat is found by hopping over the mdat.
  const late = bytes(ftyp('avif', 'mif1'), mdat(300_000), meta(ispe(12000, 12000), av1C()));
  assert.deepEqual(await sniffImage(asFile(late, 'late.avif', 'image/avif')), { format: 'avif', width: 12000, height: 12000 });
});

test('HEIC: the largest image in the file counts (a grid photo with tiles and a thumbnail)', async () => {
  const tiles = Array.from({ length: 12 }, () => ispe(512, 512));
  const photo = bytes(ftyp('heic', 'mif1', 'heic'), meta(ispe(320, 240), ...tiles, ispe(4032, 3024)));
  assert.deepEqual(await sniffImage(photo), { format: 'heic', width: 4032, height: 3024 });
  const big = bytes(ftyp('heic', 'mif1', 'heic'), meta(ispe(320, 240), ispe(16000, 12000)));
  assert.match(await precheck(asFile(big, 'IMG_0001.HEIC', 'image/heic')), /16,000 × 12,000 px/);
});

test('a recognised image whose size cannot be found is refused, not decoded blind', async () => {
  const noIspe = bytes(ftyp('avif', 'mif1', 'miaf'), meta(av1C()), mdat(64));
  assert.deepEqual(await sniffImage(noIspe), { format: 'avif', width: null, height: null });
  const avifMsg = await precheck(asFile(noIspe, 'photo.avif', 'image/avif'));
  assert.match(avifMsg, /couldn’t find the size of “photo\.avif”/i);
  assert.match(avifMsg, /JPEG or PNG/);
  assert.ok(await precheck(asFile(bytes(ftyp('heic', 'mif1', 'heic')), 'IMG_0002.HEIC', 'image/heic')), 'HEIC without meta');
  assert.ok(await precheck({ name: 'odd.jpg', type: 'image/jpeg', size: 10 }, bytes([0xff, 0xd8, 0xff])), 'a JPEG cut short');
  assert.ok(await precheck({ name: 'odd.gif', type: 'image/gif', size: 13 }, bytes('GIF89a', le16(10), le16(10), [0, 0, 0])), 'a GIF with no frame');
  // An unrecognised format still goes to the browser, and is checked again after decoding.
  assert.equal(await precheck({ name: 'mystery', type: '', size: 10 }, bytes('0123456789')), null);
});

test('pixelProblem() is the same cap, used again after decoding', () => {
  assert.equal(pixelProblem('a.jpg', 4032, 3024), null);
  assert.match(pixelProblem('a.jpg', 12000, 9000), /108 megapixels/);
  assert.match(pixelProblem('a.jpg', 0, 10), /no pixels/);
});

test('the other refusals keep their plain-English messages', async () => {
  assert.match(await precheck({ name: 'notes.txt', type: 'text/plain', size: 5 }, bytes('hello')), /isn’t an image/);
  assert.match(await precheck({ name: 'huge.jpg', type: 'image/jpeg', size: 81 * 1024 * 1024 }, jpeg(10, 10)), /over 80 MB/);
  assert.match(await precheck({ name: 'empty.png', type: 'image/png', size: 40 }, png(0, 0)), /no pixels/);
  assert.equal(await precheck({ name: 'photo.jpg', type: 'image/jpeg', size: 2e6 }, jpeg(4032, 3024)), null);
});

test('decode failures name HEIC only when the file really is HEIC', () => {
  assert.match(decodeFailure('IMG_0001.HEIC', 'heic'), /HEIC/);
  const generic = decodeFailure('broken.png', 'png');
  assert.match(generic, /couldn’t open “broken\.png”/);
  assert.doesNotMatch(generic, /HEIC/);
});

test('long names are shortened in messages', async () => {
  const name = 'a'.repeat(80) + '.svg';
  assert.match(await precheck({ name, type: 'image/svg+xml', size: 1 }, svg()), /a{36}…/);
});

test('the working copy is at most WORK_EDGE on its long edge and never upscaled', () => {
  assert.equal(WORK_EDGE, 900);
  assert.deepEqual(workingSize(4032, 3024), { width: 900, height: 675 });
  assert.deepEqual(workingSize(3024, 4032), { width: 675, height: 900 });
  assert.deepEqual(workingSize(640, 480), { width: 640, height: 480 });
  assert.deepEqual(workingSize(900, 900), { width: 900, height: 900 });
  assert.deepEqual(workingSize(100000, 3), { width: 900, height: 1 });
});
