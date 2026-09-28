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
    assert.equal(await page.evaluate('document.documentElement.dataset.state'), 'rendered');
    assert.match(await page.evaluate("document.getElementById('source-meta').textContent"), /Sample poster/, 'the print stays');

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
