// dist/ smoke test (no browser): the page references the WebAssembly build,
// every local asset exists, the .wasm is valid and it renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dist, loadWasm } from './helpers.mjs';

const read = (p) => readFileSync(join(dist, p), 'utf8');

test('index.html boots app.js, which imports the wasm-bindgen module', () => {
  const html = read('index.html');
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  const app = read('app.js');
  assert.match(app, /from '\.\/pkg\/overprint\.js'/);
  assert.match(read('pkg/overprint.js'), /overprint_bg\.wasm/);
});

test('every local asset referenced by index.html exists', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
  assert.ok(refs.length >= 4, `found ${refs.length} refs`);
  for (const r of refs) assert.ok(existsSync(join(dist, r)), `missing ${r}`);
  for (const f of ['reference.js', 'params.js', 'sample.js', 'intake.js', 'styles.css', '_headers']) {
    assert.ok(existsSync(join(dist, f)), `missing ${f}`);
  }
});

test('the .wasm is valid WebAssembly and loads', async () => {
  const bytes = readFileSync(join(dist, 'pkg', 'overprint_bg.wasm'));
  assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
  assert.ok(WebAssembly.validate(bytes));
  const wasm = await loadWasm();
  assert.equal(wasm.paramCount(), 17);
  const out = wasm.render(new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]), 2, 2,
    Int32Array.from([255, 72, 176, 0, 120, 191, 244, 240, 230, 0, 0, 0, 0, 100, 100, 1, 0]));
  assert.equal(out.length, 16);
});

test('production headers allow WebAssembly under a strict CSP', () => {
  const headers = read('_headers');
  assert.match(headers, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(headers, /unsafe-inline/);
});

test('no long cache lifetime on the unhashed JS and WebAssembly files', () => {
  // app.js, pkg/overprint.js and pkg/overprint_bg.wasm keep fixed names, so a
  // max-age could pair a new app.js with a stale engine after a redeploy.
  const headers = read('_headers');
  assert.doesNotMatch(headers, /max-age\s*=\s*[1-9]/);
  assert.doesNotMatch(headers, /immutable/);
});
