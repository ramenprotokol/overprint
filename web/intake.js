// Checks on an incoming file, before and just after the browser decodes it.
//
// checkFile() reads a file in small, bounded pieces to learn its real format
// and its size in pixels, so the page can refuse an SVG, a 200-megapixel scan,
// or a file whose size it cannot find, before asking the browser to decode it.
// A decoded image costs 4 bytes per pixel, and the browser's decoder allocates
// that before any check after decoding can run.
//
// Where the size lives, per format:
//   PNG, WebP, BMP  the header, in the first few dozen bytes.
//   GIF             the logical screen AND the first frame's image descriptor:
//                   browsers decode at the larger of the two, so a 1 × 1 screen
//                   can hold a 23,000 × 23,000 frame. Extension blocks before
//                   the frame are walked.
//   JPEG            the frame header (SOFn), found by walking the marker
//                   segments the way libjpeg does. Metadata segments before it
//                   can be megabytes long, so the walk reads on past the first
//                   piece, a little at a time.
//   AVIF, HEIC      the 'ispe' (image spatial extent) boxes in
//                   meta > iprp > ipco. The largest one counts.
// Reading is bounded (MAX_READS pieces, MAX_READ_BYTES in all), so a crafted
// file cannot make the page read on and on. If the format is recognised but
// the size is not found within that budget, the file is refused rather than
// decoded blind. Files in formats not listed here go to the browser as before
// and are checked straight after decoding (pixelProblem()).
//
// Pure functions over a Blob (a File) or bytes, no DOM: the Node tests import
// this file directly.

export const MAX_BYTES = 80 * 1024 * 1024;
export const MAX_PIXELS = 100_000_000;
/** Long edge of the one working copy the page keeps (the biggest dot count). */
export const WORK_EDGE = 900;
/** The first read: enough for the header of almost any image. */
export const HEAD_BYTES = 64 * 1024;
/** Each later read, while walking JPEG segments, GIF blocks or ISOBMFF boxes. */
export const STEP_BYTES = 1024;
/** Most reads, and most bytes read in all, spent on one file. */
export const MAX_READS = 1024;
export const MAX_READ_BYTES = 2 * 1024 * 1024;

const UNKNOWN = Object.freeze({ format: 'unknown', width: null, height: null });
const LABEL = { png: 'PNG', gif: 'GIF', jpeg: 'JPEG', webp: 'WebP', bmp: 'BMP', avif: 'AVIF', heic: 'HEIC' };
const fmt = (n) => n.toLocaleString('en');

export function displayName(name) {
  if (!name) return 'That file';
  return name.length > 40 ? name.slice(0, 37) + '…' : name;
}

function ascii(b, at, text) {
  if (b.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const i32le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const str4 = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

class OutOfBudget extends Error {}

/**
 * Reads a Blob (or bytes) through one small window, within the read budget.
 * at() returns fewer bytes than asked only at the end of the file.
 */
function reader(src) {
  const whole = src instanceof Uint8Array ? src : null;
  const size = whole ? whole.length : Number(src?.size) || 0;
  let start = 0;
  let win = new Uint8Array(0);
  let reads = 0;
  let spent = 0;
  async function load(at, n) {
    n = Math.min(n, size - at);
    if (++reads > MAX_READS || (spent += n) > MAX_READ_BYTES) throw new OutOfBudget();
    win = whole ? whole.subarray(at, at + n) : new Uint8Array(await src.slice(at, at + n).arrayBuffer());
    start = at;
  }
  const r = {
    size,
    async at(at, n) {
      if (!(at >= 0 && at < size)) return new Uint8Array(0);
      const want = Math.min(n, size - at);
      if (at < start || at + want > start + win.length) await load(at, Math.max(want, at === 0 ? HEAD_BYTES : STEP_BYTES));
      return win.subarray(at - start, at - start + want);
    },
    async byte(at) {
      const b = await r.at(at, 1);
      return b.length ? b[0] : -1;
    },
    /** Offset of the next `value` at or after `from`, or -1. */
    async find(value, from) {
      for (let p = from; p < size; ) {
        const w = p >= start && p < start + win.length ? win.subarray(p - start) : await r.at(p, STEP_BYTES);
        const k = w.indexOf(value);
        if (k >= 0) return p + k;
        p += w.length;
      }
      return -1;
    },
  };
  return r;
}

function looksLikeSvg(b) {
  const n = Math.min(b.length, 2048);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
  s = s.replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  if (!s.startsWith('<')) return false;
  // Skip an XML prolog, comments and a doctype, then expect the <svg> root.
  const rest = s.replace(/^(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|\s+)*/i, '');
  return /^<svg[\s>/]/i.test(rest);
}

/** Brands in an ISOBMFF 'ftyp' box at the start of the file: major, then compatible. */
function brands(b) {
  const end = Math.min(b.length, Math.max(16, u32be(b, 0)));
  const out = [str4(b, 8)];
  for (let i = 16; i + 4 <= end; i += 4) out.push(str4(b, i));
  return out;
}

/** Real format of a file from its first bytes. */
function formatOf(b) {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG')) return 'png';
  if (ascii(b, 0, 'GIF8')) return 'gif';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  if (ascii(b, 0, 'BM') && b.length >= 26) return 'bmp';
  if (ascii(b, 4, 'ftyp') && b.length >= 12) {
    // Browsers decode AVIF when 'avif' or 'avis' is among the brands, major or not.
    const list = brands(b);
    if (list.some((x) => x === 'avif' || x === 'avis')) return 'avif';
    if (list.some((x) => /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(x))) return 'heic';
  }
  if (looksLikeSvg(b)) return 'svg';
  return 'unknown';
}

async function gifSize(r, head) {
  if (head.length < 13) return null;
  const screenW = u16le(head, 6);
  const screenH = u16le(head, 8);
  const flags = head[10];
  let p = 13 + (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0); // skip the global colour table
  for (;;) {
    const kind = await r.byte(p);
    if (kind === 0x2c) {
      // Image descriptor: left, top, width, height. Browsers decode the first
      // frame into a canvas big enough for both it and the logical screen.
      const d = await r.at(p + 1, 8);
      if (d.length < 8) return null;
      return {
        width: Math.max(screenW, u16le(d, 0) + u16le(d, 4)),
        height: Math.max(screenH, u16le(d, 2) + u16le(d, 6)),
      };
    }
    if (kind !== 0x21) return null; // trailer, end of file or junk: no frame to decode
    p += 2; // extension introducer and label, then data sub-blocks up to an empty one
    let n;
    while ((n = await r.byte(p)) > 0) p += n + 1;
    if (n < 0) return null;
    p += 1;
  }
}

async function jpegSize(r) {
  const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
  let p = 2; // just after the start-of-image marker
  for (;;) {
    // Find the next marker as libjpeg's next_marker() does: skip bytes that are
    // not 0xFF, swallow 0xFF fill bytes, and step over stuffed FF 00 pairs.
    let m = 0;
    while (m === 0) {
      p = await r.find(0xff, p);
      if (p < 0) return null;
      do m = await r.byte(++p);
      while (m === 0xff);
      if (m < 0) return null;
      p++;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // markers with no length
    if (m === 0xd9 || m === 0xda) return null; // end of image / start of scan: no frame header
    const seg = await r.at(p, 7); // length, then (for SOFn) precision, height, width
    if (seg.length < 2) return null;
    if (isSof(m)) return seg.length < 7 ? null : { height: u16be(seg, 3), width: u16be(seg, 5) };
    p += Math.max(2, u16be(seg, 0)); // libjpeg skips a length below 2 as just the length bytes
  }
}

/** Header of the ISOBMFF box at `p`: its type, header length and total size. */
async function boxAt(r, p) {
  const h = await r.at(p, 16);
  if (h.length < 8) return null;
  let size = u32be(h, 0);
  let head = 8;
  if (size === 1) {
    if (h.length < 16) return null;
    size = u32be(h, 8) * 2 ** 32 + u32be(h, 12);
    head = 16;
  } else if (size === 0) {
    size = r.size - p; // runs to the end of the file
  }
  return size < head ? null : { type: str4(h, 4), head, size };
}

/** Child boxes of the box body b[from, to). */
function* children(b, from, to) {
  for (let p = from; p + 8 <= to; ) {
    let size = u32be(b, p);
    let head = 8;
    if (size === 1) {
      if (p + 16 > to) return;
      size = u32be(b, p + 8) * 2 ** 32 + u32be(b, p + 12);
      head = 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < head || p + size > to) return;
    yield { type: str4(b, p + 4), from: p + head, to: p + size };
    p += size;
  }
}

async function heifSize(r) {
  // Hop over the top-level boxes (a large 'mdat' may come first) to 'meta'.
  for (let p = 0; p < r.size; ) {
    const box = await boxAt(r, p);
    if (!box) return null;
    if (box.type === 'meta') {
      if (box.size > MAX_READ_BYTES) return null;
      const b = await r.at(p, box.size);
      if (b.length < box.size) return null;
      // meta is a full box (4 bytes of version and flags before its children).
      let best = null;
      for (const iprp of children(b, box.head + 4, box.size)) {
        if (iprp.type !== 'iprp') continue;
        for (const ipco of children(b, iprp.from, iprp.to)) {
          if (ipco.type !== 'ipco') continue;
          for (const prop of children(b, ipco.from, ipco.to)) {
            if (prop.type !== 'ispe' || prop.to - prop.from < 12) continue;
            const width = u32be(b, prop.from + 4);
            const height = u32be(b, prop.from + 8);
            if (!best || width * height > best.width * best.height) best = { width, height };
          }
        }
      }
      return best;
    }
    p += box.size;
  }
  return null;
}

/** Pixel size of a file whose format is known, or null if it cannot be found within the budget. */
async function sizeOf(format, r, b) {
  try {
    switch (format) {
      case 'png':
        return b.length >= 24 && ascii(b, 12, 'IHDR') ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
      case 'gif':
        return await gifSize(r, b);
      case 'jpeg':
        return await jpegSize(r);
      case 'webp':
        if (ascii(b, 12, 'VP8X') && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
        if (ascii(b, 12, 'VP8 ') && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
          return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
        }
        if (ascii(b, 12, 'VP8L') && b.length >= 25 && b[20] === 0x2f) {
          const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
          return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        return null;
      case 'bmp':
        return { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) }; // height < 0 means top-down
      case 'avif':
      case 'heic':
        return await heifSize(r);
      default:
        return null;
    }
  } catch {
    return null; // out of budget, or the file could not be read
  }
}

async function readHead(r) {
  try {
    return await r.at(0, HEAD_BYTES);
  } catch {
    return new Uint8Array(0); // unreadable: the decode reports it
  }
}

/** Real format of a file (a Blob or bytes), plus its pixel size when it can be found. */
export async function sniffImage(src) {
  const r = reader(src);
  const head = await readHead(r);
  const format = formatOf(head);
  if (format === 'unknown') return UNKNOWN;
  const size = await sizeOf(format, r, head);
  return { format, width: size?.width ?? null, height: size?.height ?? null };
}

/** Message if a decoded (or header-declared) size is too big or empty, else null. */
export function pixelProblem(name, width, height) {
  const n = displayName(name);
  if (!width || !height) return `“${n}” has no pixels to print.`;
  const px = width * height;
  if (px > MAX_PIXELS) {
    return `“${n}” is ${fmt(width)} × ${fmt(height)} px (${fmt(Math.round(px / 1e6))} megapixels). overprint takes images up to ${fmt(MAX_PIXELS / 1e6)} megapixels. Resize it and try again.`;
  }
  return null;
}

/**
 * Everything that can be refused before decoding. `file` is { name, type, size }
 * and `src` is what to read (the file itself, or bytes in the tests).
 * Resolves to { format, width, height, problem }, where problem is a message or
 * null to go ahead. Never rejects.
 */
export async function checkFile(file, src = file) {
  const n = displayName(file.name);
  const r = reader(src);
  const head = await readHead(r);
  const format = formatOf(head);
  const result = (problem, size = null) => ({ format, width: size?.width ?? null, height: size?.height ?? null, problem });
  if (file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name || '') || format === 'svg') {
    return result(`“${n}” is an SVG drawing, which isn’t supported. Use a photo (JPEG, PNG or WebP).`);
  }
  if (file.type && !file.type.startsWith('image/')) {
    return result(`“${n}” isn’t an image. Choose a JPG, PNG, WebP or GIF.`);
  }
  if (file.size > MAX_BYTES) {
    return result(`“${n}” is over ${MAX_BYTES / 1024 / 1024} MB. Choose a smaller image.`);
  }
  if (format === 'unknown') return result(null); // the browser tries; pixelProblem() checks after decoding
  const size = await sizeOf(format, r, head);
  if (!size) {
    return result(`Couldn’t find the size of “${n}” (${LABEL[format]}) without decoding it, so overprint won’t open it. It may be damaged, or its size may be buried deep in the file. Save it again as a JPEG or PNG and try again.`);
  }
  return result(pixelProblem(file.name, size.width, size.height), size);
}

/** Just the message from checkFile(): null to go ahead. */
export async function precheck(file, src = file) {
  return (await checkFile(file, src)).problem;
}

/** Message when the browser could not decode the file. */
export function decodeFailure(name, format) {
  const n = displayName(name);
  if (format === 'heic') {
    return `This browser can’t read HEIC photos such as “${n}”. Save it as a JPEG and try again.`;
  }
  return `This browser couldn’t open “${n}”. It may be damaged, or in a format the browser can’t read. Try a JPEG or PNG.`;
}

/** Size of the single working copy kept after decoding: long edge ≤ WORK_EDGE, never upscaled. */
export function workingSize(width, height, edge = WORK_EDGE) {
  const s = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}
