// End-to-end smoke test in real headless Chrome, against dist/ served with
// the production _headers (including the Content-Security-Policy).
// Skips when Chrome is not installed (set CHROME_PATH to point at one), unless
// REQUIRE_BROWSER=1 is set, in which case a missing Chrome fails the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../scripts/serve.mjs';
import { dist } from './helpers.mjs';
import { browserPlan, findChrome, launchChrome } from './cdp.mjs';

const chromePath = findChrome();
const plan = browserPlan(chromePath);
// With REQUIRE_BROWSER=1 and no Chrome, the smoke test itself is skipped and a
// separate test fails loudly instead.
const skip = plan.run ? false : plan.skip ?? plan.fail;

if (plan.fail) {
  test('browser smoke test can run', () => assert.fail(plan.fail));
}

// Every request the page made, other than inline data: URLs, is to this server.
const OFF_ORIGIN = `performance.getEntriesByType('resource').map((e) => e.name)
  .filter((u) => !u.startsWith('data:') && new URL(u).origin !== location.origin)`;

// The self-hosted faces load (under the production CSP) and are ready to draw.
// document.fonts.load() rejects if a file is blocked or broken, and resolves
// with the faces it loaded; check() is then true for each descriptor.
const FACES = `(async () => {
  await document.fonts.ready;
  const out = {};
  for (const d of ['400 16px Archivo', '700 16px Archivo', '400 12px "IBM Plex Mono"', '500 12px "IBM Plex Mono"']) {
    const loaded = await document.fonts.load(d);
    out[d] = { faces: loaded.filter((f) => f.status === 'loaded').length, check: document.fonts.check(d) };
  }
  out.files = performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => p.endsWith('.woff2')).sort();
  return out;
})()`;

// body is a string, or an array of byte values.
const DROP = (name, body, type) => `(() => {
  const dt = new DataTransfer();
  const body = ${JSON.stringify(body)};
  const part = typeof body === 'string' ? body : new Uint8Array(body);
  dt.items.add(new File([part], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
  return true;
})()`;

// A PNG header claiming 20,000 × 10,000 px (200 megapixels) and nothing else.
const HUGE_PNG = [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0x4e, 0x20, 0, 0, 0x27, 0x10, 8, 6, 0, 0, 0];
// A GIF whose logical screen is 1 × 1 but whose first frame is 12,000 × 9,000
// (108 megapixels): the page must read the frame, not just the screen.
const SNEAKY_GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0,
  0x21, 0xf9, 4, 0, 0, 0, 0, 0,
  0x2c, 0, 0, 0, 0, 0xe0, 0x2e, 0x28, 0x23, 0, 2, 2, 0x4c, 0x01, 0, 0x3b];
// An AVIF that names no size (no 'ispe' box): refused rather than decoded blind.
const box = (type, body) => [...[24, 16, 8, 0].map((s) => ((8 + body.length) >>> s) & 255), ...[...type].map((c) => c.charCodeAt(0)), ...body];
const NO_SIZE_AVIF = [...box('ftyp', [...'avif\0\0\0\0mif1'].map((c) => c.charCodeAt(0))),
  ...box('meta', [0, 0, 0, 0, ...box('iprp', box('ipco', box('av1C', [0x81, 0, 0x0c, 0])))])];
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
const errorText = "document.getElementById('error').textContent";

test('dist/ loads in headless Chrome, renders with WebAssembly, and survives bad input', { skip, timeout: 120000 }, async () => {
  const server = await serve(dist);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const chrome = await launchChrome(chromePath);
  try {
    const page = await chrome.openPage({ width: 1280, height: 800 });
    await page.navigate(url);
    await page.waitFor("document.documentElement.dataset.state === 'rendered'");
    assert.equal(await page.evaluate('document.documentElement.dataset.engine'), 'wasm');

    // Fonts come from this site: nothing is fetched from anywhere else.
    const faces = await page.evaluate(FACES);
    assert.deepEqual(await page.evaluate(OFF_ORIGIN), [], 'requests left the site');
    for (const [d, r] of Object.entries(faces)) {
      if (d === 'files') continue;
      assert.ok(r.faces >= 1 && r.check, `${d} did not load from a self-hosted face: ${JSON.stringify(r)}`);
    }
    assert.deepEqual(faces.files, ['/fonts/archivo-variable.woff2', '/fonts/ibm-plex-mono-400.woff2', '/fonts/ibm-plex-mono-500.woff2']);

    // First view: the sample poster at 400 dots, drawn at whole device pixels per dot.
    const first = await page.evaluate(`(() => {
      const c = document.getElementById('print');
      return { w: c.width, h: c.height, css: c.getBoundingClientRect().width, preview: document.documentElement.dataset.preview,
        meta: document.getElementById('source-meta').textContent, out: document.getElementById('export-meta').textContent };
    })()`);
    assert.equal(first.w, 400);
    assert.match(first.meta, /Sample poster/);
    assert.equal(first.preview, '2', 'a 1280 × 800 window shows each dot as 2 × 2 pixels');
    assert.equal(first.css, 800);
    assert.equal(first.out, `2400 × ${first.h * 6} px`);

    const inked = await page.evaluate(`(() => {
      const c = document.getElementById('print');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] !== 244 || d[i + 1] !== 240 || d[i + 2] !== 230) n++;
      return n / (d.length / 4);
    })()`);
    assert.ok(inked > 0.2, `only ${(inked * 100).toFixed(1)}% of dots carry ink`);

    // The in-page race must find byte-identical output.
    await page.evaluate("document.getElementById('race').click(), true");
    await page.waitFor("document.getElementById('identical').textContent.startsWith('Identical output')", 60000);
    assert.match(await page.evaluate("document.getElementById('t-wasm').textContent"), /ms$/);

    // Bad input gives a clear message and leaves the print alone.
    await page.evaluate(DROP('notes.txt', 'hello', 'text/plain'));
    await page.waitFor("!document.getElementById('error').hidden");
    assert.match(await page.evaluate("document.getElementById('error').textContent"), /isn’t an image/);
    await page.evaluate(DROP('broken.png', 'this is not a png', 'image/png'));
    await page.waitFor(`${errorText}.includes('couldn’t open')`);
    assert.doesNotMatch(await page.evaluate(errorText), /HEIC/);
    await page.evaluate(DROP('logo.svg', SVG, 'image/svg+xml'));
    await page.waitFor(`${errorText}.includes('SVG')`);
    assert.match(await page.evaluate(errorText), /isn’t supported\. Use a photo \(JPEG, PNG or WebP\)/);
    await page.evaluate(DROP('scan.png', HUGE_PNG, 'image/png'));
    await page.waitFor(`${errorText}.includes('megapixels')`);
    assert.match(await page.evaluate(errorText), /20,000 × 10,000 px \(200 megapixels\)/);
    await page.evaluate(DROP('tiny.gif', SNEAKY_GIF, 'image/gif'));
    await page.waitFor(`${errorText}.includes('12,000')`);
    assert.match(await page.evaluate(errorText), /12,000 × 9,000 px \(108 megapixels\)/);
    await page.evaluate(DROP('photo.avif', NO_SIZE_AVIF, 'image/avif'));
    await page.waitFor(`${errorText}.includes('photo.avif')`);
    assert.match(await page.evaluate(errorText), /Couldn’t find the size of “photo\.avif” \(AVIF\)/);
    assert.equal(await page.evaluate('document.documentElement.dataset.state'), 'rendered');
    assert.match(await page.evaluate("document.getElementById('source-meta').textContent"), /Sample poster/, 'the print stays');

    // Real photos still go through: a JPEG the browser encodes itself, and a valid 1 × 1 GIF.
    await page.evaluate(`(async () => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      const g = c.getContext('2d');
      g.fillStyle = '#c33'; g.fillRect(0, 0, 640, 480); g.fillStyle = '#39c'; g.fillRect(100, 80, 300, 200);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'real.jpg', { type: 'image/jpeg' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
      return true;
    })()`);
    await page.waitFor("document.getElementById('source-meta').textContent.startsWith('real.jpg')");
    assert.equal(await page.evaluate("document.getElementById('source-meta').textContent"), 'real.jpg · 640 × 480 px');
    assert.equal(await page.evaluate("document.getElementById('error').hidden"), true);
    await page.evaluate(DROP('dot.gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0,
      0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b], 'image/gif'));
    await page.waitFor("document.getElementById('source-meta').textContent.startsWith('dot.gif')");
    assert.equal(await page.evaluate("document.getElementById('source-meta').textContent"), 'dot.gif · 1 × 1 px');
    await page.waitFor("document.documentElement.dataset.state === 'rendered'");

    assert.equal(await page.evaluate('document.documentElement.dataset.errors'), '0');
    assert.deepEqual(await page.evaluate(OFF_ORIGIN), [], 'requests left the site');
    assert.deepEqual(page.problems, [], 'console errors, CSP violations or exceptions');
    await page.close();

    // Phone width: no horizontal scroll, no errors, in the darkroom theme too.
    for (const scheme of ['light', 'dark']) {
      const phone = await chrome.openPage({ width: 400, height: 860, mobile: true, scale: 2, scheme });
      await phone.navigate(url);
      await phone.waitFor("document.documentElement.dataset.state === 'rendered'");
      const { sw, vw } = await phone.evaluate('({ sw: document.documentElement.scrollWidth, vw: innerWidth })');
      assert.ok(sw <= vw, `${scheme}: page is ${sw}px wide in a ${vw}px viewport`);
      assert.deepEqual(await phone.evaluate(OFF_ORIGIN), [], `${scheme}: requests left the site`);
      assert.deepEqual(phone.problems, [], `${scheme}: console errors, CSP violations or exceptions`);
      await phone.close();
    }
  } finally {
    await chrome.close();
    server.close();
  }
});
