// Checks on an incoming file, before and just after the browser decodes it.
//
// sniffImage() reads the first bytes of a file to learn its real format and,
// for PNG, GIF, JPEG and WebP, its size in pixels. That lets the page refuse
// an SVG or a 200-megapixel scan with a clear message before asking the
// browser to decode it (a decoded image costs 4 bytes per pixel).
//
// Pure functions, no DOM: the Node tests import this file directly.

export const MAX_BYTES = 80 * 1024 * 1024;
export const MAX_PIXELS = 100_000_000;
/** Long edge of the one working copy the page keeps (the biggest dot count). */
export const WORK_EDGE = 900;
/** How much of a file sniffImage() needs to see. JPEG metadata can be long. */
export const HEAD_BYTES = 256 * 1024;

const UNKNOWN = Object.freeze({ format: 'unknown', width: null, height: null });
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

function sized(format, width, height) {
  return { format, width, height };
}

function jpegSize(b) {
  // Walk the marker segments until a start-of-frame (SOFn) marker.
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // no length
    if (m === 0xd9 || m === 0xda) return null; // end of image / start of scan: no frame header seen
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (i + 8 >= b.length) return null;
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + len;
  }
  return null;
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

/** Real format of a file from its first bytes, plus its pixel size when the header says. */
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG')) {
    if (b.length >= 24 && ascii(b, 12, 'IHDR')) return sized('png', u32be(b, 16), u32be(b, 20));
    return sized('png', null, null);
  }
  if (ascii(b, 0, 'GIF8')) {
    return b.length >= 10 ? sized('gif', u16le(b, 6), u16le(b, 8)) : sized('gif', null, null);
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const s = jpegSize(b);
    return s ? sized('jpeg', s.width, s.height) : sized('jpeg', null, null);
  }
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) {
    if (ascii(b, 12, 'VP8X') && b.length >= 30) return sized('webp', u24le(b, 24) + 1, u24le(b, 27) + 1);
    if (ascii(b, 12, 'VP8 ') && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return sized('webp', u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    }
    if (ascii(b, 12, 'VP8L') && b.length >= 25 && b[20] === 0x2f) {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return sized('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return sized('webp', null, null);
  }
  if (ascii(b, 0, 'BM') && b.length >= 26) {
    return sized('bmp', Math.abs(i32le(b, 18)), Math.abs(i32le(b, 22))); // height < 0 means top-down
  }
  if (ascii(b, 4, 'ftyp') && b.length >= 12) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return sized('heic', null, null);
    if (/^(avif|avis)$/.test(brand)) return sized('avif', null, null);
  }
  if (looksLikeSvg(b)) return sized('svg', null, null);
  return UNKNOWN;
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
 * and `head` is the first HEAD_BYTES of it. Returns a message, or null to go ahead.
 */
export function precheck(file, head) {
  const n = displayName(file.name);
  const sniff = sniffImage(head);
  if (file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name || '') || sniff.format === 'svg') {
    return `“${n}” is an SVG drawing, which isn’t supported. Use a photo (JPEG, PNG or WebP).`;
  }
  if (file.type && !file.type.startsWith('image/')) {
    return `“${n}” isn’t an image. Choose a JPG, PNG, WebP or GIF.`;
  }
  if (file.size > MAX_BYTES) {
    return `“${n}” is over ${MAX_BYTES / 1024 / 1024} MB. Choose a smaller image.`;
  }
  if (sniff.width !== null) return pixelProblem(file.name, sniff.width, sniff.height);
  return null;
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
