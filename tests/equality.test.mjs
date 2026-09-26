// The plain-JavaScript reference must produce exactly the same bytes as the
// Rust core compiled to WebAssembly. Runs in Node against dist/pkg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWasm, testCard, gradientCard, fnv1a, params, firstDiff } from './helpers.mjs';
import * as ref from '../web/reference.js';
import { PRESETS } from '../web/params.js';

const wasm = await loadWasm();
const INKS = Object.values(PRESETS).map((p) => [p.a.rgb, p.b.rgb]);

function same(img, w, h, p, label) {
  const a = wasm.render(img, w, h, p);
  const b = ref.render(img, w, h, p);
  assert.equal(a.length, w * h * 4, `${label}: wasm length`);
  const d = firstDiff(a, b);
  assert.equal(d, -1, `${label}: first differing byte at ${d} (pixel ${Math.floor(d / 4)})`);
}

test('hash3 agrees with the Rust mixer', () => {
  // Same vectors as src/hash.rs.
  assert.equal(ref.hash3(0, 0, 0), 0);
  assert.equal(ref.hash3(1, 2, 3), 72785788);
  assert.equal(ref.hash3(0xdeadbeef, 7, 0x9e3779b9), 2159002690);
  assert.equal(ref.hash3(8191, 8191, 417), 3192395201);
  assert.notEqual(ref.hash3(1, 2, 3), ref.hash3(2, 1, 3));
});

test('blue-noise threshold map is identical (and a permutation)', () => {
  const w = wasm.blueNoiseMap();
  const j = ref.blueNoiseMap();
  assert.equal(w.length, 4096);
  assert.equal(firstDiff(w, j), -1);
  assert.equal(new Set(j).size, 4096);
});

test('every preset x dither x view matches byte for byte on small images', () => {
  const sizes = [[1, 1], [2, 2], [3, 1], [1, 5], [7, 5], [16, 16], [33, 17]];
  let cases = 0;
  for (const [w, h] of sizes) {
    const cards = [testCard(w, h), gradientCard(w, h)];
    for (const img of cards) {
      for (const [a, b] of INKS) {
        for (let dither = 0; dither < 3; dither++) {
          for (let view = 0; view < 3; view++) {
            const p = params(a, b, dither, [1, -1], 45, 77, view);
            same(img, w, h, p, `${w}x${h} dither ${dither} view ${view}`);
            cases++;
          }
        }
      }
    }
  }
  assert.ok(cases >= 378);
});

test('grain, density, registration and seed sweep matches', () => {
  const w = 48, h = 31;
  const img = gradientCard(w, h, 9);
  const [a, b] = INKS[0];
  for (const grain of [0, 1, 37, 100]) {
    for (const reg of [[0, 0], [16, 16], [-16, 3], [5, -9]]) {
      for (const seed of [0, 1, -1, 2147483647, -2147483648]) {
        for (const density of [[0, 200], [100, 100], [63, 141]]) {
          for (let dither = 0; dither < 3; dither++) {
            same(img, w, h, params(a, b, dither, reg, grain, seed, 0, density), `g${grain} r${reg} s${seed} d${density} m${dither}`);
          }
        }
      }
    }
  }
});

test('out-of-range parameters are clamped the same way', () => {
  const img = testCard(20, 12);
  const [a, b] = INKS[2];
  const wild = params([999, -4, 128], b, 1, [900, -900], 5000, 3, 0, [-10, 999]);
  same(img, 20, 12, wild, 'wild params');
});

test('golden fingerprints match the native Rust test (tests/determinism.rs)', () => {
  const img = testCard(120, 80);
  const cases = [
    [params(INKS[0][0], INKS[0][1], 0, [0, 0], 0, 7, 0), 0x4ab4027d],
    [params(INKS[0][0], INKS[0][1], 1, [2, -1], 40, 7, 0), 0x93bf8739],
    [params(INKS[1][0], INKS[1][1], 2, [-3, 4], 80, 99, 0), 0xaacfdabd],
    [params(INKS[2][0], INKS[2][1], 0, [5, 5], 100, 3, 2), 0x4dd8ec25],
  ];
  for (const [p, want] of cases) {
    assert.equal(fnv1a(wasm.render(img, 120, 80, p)), want, 'wasm');
    assert.equal(fnv1a(ref.render(img, 120, 80, p)), want, 'js');
  }
});

test('bad input is rejected by both engines', () => {
  const p = params(INKS[0][0], INKS[0][1], 0, [0, 0], 0, 1, 0);
  assert.throws(() => wasm.render(new Uint8Array(15), 2, 2, p));
  assert.throws(() => ref.render(new Uint8Array(15), 2, 2, p));
  assert.throws(() => wasm.render(new Uint8Array(0), 0, 0, p));
  assert.throws(() => ref.render(new Uint8Array(0), 0, 0, p));
  const bad = p.slice();
  bad[9] = 7;
  assert.throws(() => wasm.render(new Uint8Array(4), 1, 1, bad));
  assert.throws(() => ref.render(new Uint8Array(4), 1, 1, bad));
  assert.throws(() => wasm.render(new Uint8Array(4), 1, 1, new Int32Array(3)));
  assert.throws(() => ref.render(new Uint8Array(4), 1, 1, new Int32Array(3)));
});
