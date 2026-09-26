// Shared test helpers: load the built WebAssembly and make synthetic images.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const dist = join(root, 'dist');

export async function loadWasm() {
  const js = join(dist, 'pkg', 'overprint.js');
  const bin = join(dist, 'pkg', 'overprint_bg.wasm');
  if (!existsSync(js) || !existsSync(bin)) {
    throw new Error('dist/pkg is missing: run `npm run build` first');
  }
  const mod = await import(js);
  mod.initSync({ module: readFileSync(bin) });
  return mod;
}

/** Same synthetic test card as tests/determinism.rs. */
export function testCard(w, h) {
  const v = new Uint8Array(w * h * 4);
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      v[o++] = (x * 37 + y * 11) & 255;
      v[o++] = (x * 5 + y * 23 + 64) & 255;
      v[o++] = ((x ^ y) * 13) & 255;
      v[o++] = (x + y) % 7 === 0 ? 128 : 255;
    }
  }
  return v;
}

/** Smooth gradients plus hard edges: closer to a photo than the test card. */
export function gradientCard(w, h, salt = 0) {
  const v = new Uint8Array(w * h * 4);
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inDisc = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (Math.min(w, h) / 3) ** 2;
      v[o++] = Math.floor((255 * x) / Math.max(1, w - 1));
      v[o++] = Math.floor((255 * y) / Math.max(1, h - 1));
      v[o++] = inDisc ? 40 + salt : 220 - salt;
      v[o++] = 255;
    }
  }
  return v;
}

export function fnv1a(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function params(inkA, inkB, dither, reg, grain, seed, view, density = [100, 100]) {
  return Int32Array.from([
    ...inkA, ...inkB, 244, 240, 230, dither, reg[0], reg[1], grain, density[0], density[1], seed, view,
  ]);
}

export function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
