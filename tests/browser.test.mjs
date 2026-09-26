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

// Web fonts come from a third party; if the machine is offline that is not an app error.
const appProblems = (list) => list.filter((p) => !/fonts\.(googleapis|gstatic)\.com/.test(`${p.text} ${p.url ?? ''}`));

const DROP = (name, body, type) => `(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([${JSON.stringify(body)}], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
  return true;
})()`;

test('dist/ loads in headless Chrome, renders with WebAssembly, and survives bad input', { skip, timeout: 120000 }, async () => {
  const server = await serve(dist);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const chrome = await launchChrome(chromePath);
  try {
    const page = await chrome.openPage({ width: 1280, height: 800 });
    await page.navigate(url);
    await page.waitFor("document.documentElement.dataset.state === 'rendered'");
    assert.equal(await page.evaluate('document.documentElement.dataset.engine'), 'wasm');

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
    await page.waitFor("document.getElementById('error').textContent.includes('couldn’t open')");
    assert.equal(await page.evaluate('document.documentElement.dataset.state'), 'rendered');

    assert.equal(await page.evaluate('document.documentElement.dataset.errors'), '0');
    assert.deepEqual(appProblems(page.problems), []);
    await page.close();

    // Phone width: no horizontal scroll, no errors, in the darkroom theme too.
    for (const scheme of ['light', 'dark']) {
      const phone = await chrome.openPage({ width: 400, height: 860, mobile: true, scale: 2, scheme });
      await phone.navigate(url);
      await phone.waitFor("document.documentElement.dataset.state === 'rendered'");
      const { sw, vw } = await phone.evaluate('({ sw: document.documentElement.scrollWidth, vw: innerWidth })');
      assert.ok(sw <= vw, `${scheme}: page is ${sw}px wide in a ${vw}px viewport`);
      assert.deepEqual(appProblems(phone.problems), []);
      await phone.close();
    }
  } finally {
    await chrome.close();
    server.close();
  }
});
