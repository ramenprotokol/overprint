// Body and caption text reach WCAG AA (4.5:1) in both rooms. Colours are read
// straight from web/styles.css. In the darkroom the text is checked against
// the brightest the table gets: both red safelight pools, the amber spill and
// the ticket's own tint stacked on top of each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './helpers.mjs';

const css = readFileSync(join(root, 'web', 'styles.css'), 'utf8');

function block(selector) {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `missing ${selector}`);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open)); // token blocks hold no nested braces
}
function tokens(text) {
  const out = {};
  for (const m of text.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  return out;
}
function parse(c) {
  let m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(c);
  if (m) return [+m[1], +m[2], +m[3], +m[4]];
  throw new Error(`cannot parse colour ${c}`);
}
const over = (top, under) => {
  const [r, g, b, a] = parse(top);
  const [R, G, B] = typeof under === 'string' ? parse(under) : under;
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
};
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg, bg) {
  const a = luminance(typeof fg === 'string' ? parse(fg).slice(0, 3) : fg);
  const b = luminance(typeof bg === 'string' ? parse(bg).slice(0, 3) : bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const light = tokens(block(':root'));
const darkMedia = tokens(block(":root:not([data-theme='light'])"));
const darkForced = tokens(block(":root[data-theme='dark']"));
const dark = { ...light, ...darkForced };

test('the system-dark and chosen-dark darkroom blocks are identical', () => {
  assert.deepEqual(darkMedia, darkForced);
});

test('light room: every text colour reaches 4.5:1', () => {
  const pairs = [
    ['--key', '--table'],
    ['--muted', '--table'],
    ['--table', '--key'], // button and selected-segment text
    ['--on-sheet', '--sheet'],
    ['--on-sheet-muted', '--sheet'], // the slug line on the sheet
  ];
  for (const [fg, bg] of pairs) {
    const r = contrast(light[fg], light[bg]);
    assert.ok(r >= 4.5, `${fg} on ${bg}: ${r.toFixed(2)}:1`);
  }
});

test('darkroom: every text colour reaches 4.5:1, even where the safelight is brightest', () => {
  const lit = over(dark['--ticket-tint'], over(dark['--glow-amber'], over(dark['--glow-bed'], over(dark['--glow'], dark['--table']))));
  for (const fg of ['--key', '--muted']) {
    const plain = contrast(dark[fg], dark['--table']);
    const worst = contrast(dark[fg], lit);
    assert.ok(plain >= 4.5, `${fg} on the table: ${plain.toFixed(2)}:1`);
    assert.ok(worst >= 4.5, `${fg} under the safelight: ${worst.toFixed(2)}:1`);
  }
  const buttons = contrast(dark['--table'], dark['--key']);
  assert.ok(buttons >= 4.5, `button text: ${buttons.toFixed(2)}:1`);
  // The sheet keeps the light-room paper and slug colours.
  assert.equal(dark['--sheet'], light['--sheet']);
  assert.ok(contrast(dark['--on-sheet-muted'], dark['--sheet']) >= 4.5);
});

test('the safelight is actually red: more red than green or blue, and visible', () => {
  const [r, g, b, a] = parse(dark['--glow']);
  assert.ok(r > 2 * g && r > 2 * b, dark['--glow']);
  assert.ok(a >= 0.2, 'too faint to read as a safelight');
});
