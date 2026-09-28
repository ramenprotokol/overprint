// The typefaces ship with the site: dist/ names no Google Fonts host, the CSP
// only allows styles and fonts from the site itself, and every @font-face in
// the stylesheet points at a WOFF2 file that is really in dist/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dist } from './helpers.mjs';

const read = (p) => readFileSync(join(dist, p), 'utf8');
const GOOGLE = /googleapis|gstatic|fonts\.google/i;

/** @font-face rules in a stylesheet: family, style, weight and the url() it loads. */
function fontFaces(css) {
  return [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => {
    const prop = (name) => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim();
    return {
      family: prop('font-family')?.replace(/["']/g, ''),
      style: prop('font-style') ?? 'normal',
      weight: prop('font-weight'),
      display: prop('font-display'),
      urls: [...body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]),
    };
  });
}

test('no shipped page, stylesheet or header names a Google Fonts host', () => {
  for (const f of ['index.html', 'styles.css', '_headers']) {
    assert.doesNotMatch(read(f), GOOGLE, `${f} still names Google Fonts`);
  }
});

test("the CSP allows styles and fonts from this site only", () => {
  const csp = /Content-Security-Policy:\s*(.+)/.exec(read('_headers'))[1];
  const directive = (name) => new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`).exec(csp)?.[1].trim();
  assert.equal(directive('font-src'), "'self'");
  assert.equal(directive('style-src'), "'self'");
});

test('Archivo and IBM Plex Mono are self-hosted WOFF2 files, each referenced from the stylesheet', () => {
  const css = read('styles.css');
  const faces = fontFaces(css);
  const families = new Set(faces.map((f) => f.family));
  for (const family of ['Archivo', 'IBM Plex Mono']) {
    assert.ok(families.has(family), `no @font-face for ${family}`);
    assert.match(css, new RegExp(`--(?:sans|mono):\\s*'${family}'`), `${family} is not the face the page asks for`);
  }
  assert.ok(faces.some((f) => f.family === 'Archivo' && /^\d+ \d+$/.test(f.weight ?? '')), 'Archivo is declared as a variable weight range');
  const mono = faces.filter((f) => f.family === 'IBM Plex Mono').map((f) => f.weight).sort();
  assert.deepEqual(mono, ['400', '500']);

  const referenced = new Set();
  for (const face of faces) {
    assert.equal(face.display, 'swap', `${face.family} ${face.weight} should use font-display: swap`);
    assert.ok(face.urls.length > 0, `${face.family} ${face.weight} has no url()`);
    for (const url of face.urls) {
      assert.doesNotMatch(url, /^(https?:)?\/\//, `${url} is not on this site`);
      const file = join(dist, url);
      assert.ok(existsSync(file), `dist/${url} is missing`);
      assert.equal(readFileSync(file).subarray(0, 4).toString('latin1'), 'wOF2', `${url} is not WOFF2`);
      referenced.add(url.replace(/^\.\//, ''));
    }
  }
  assert.ok(existsSync(join(dist, 'fonts')), 'dist/fonts/ is missing');
  const shipped = readdirSync(join(dist, 'fonts')).filter((f) => f.endsWith('.woff2')).map((f) => `fonts/${f}`);
  assert.deepEqual([...referenced].sort(), shipped.sort(), 'every shipped font file is used, and every used one ships');
  assert.ok(shipped.length >= 3);
});
