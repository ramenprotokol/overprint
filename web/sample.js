// The built-in sample: a bold two-colour poster, drawn in code. No
// photograph, no copyright.
//
// It is designed the way a stencil-print poster is: as two plates. Each shape
// says how much of ink A and ink B it wants (flat solids, a few flat tints and
// one gradient), and the poster is then painted in the current ink pair, so it
// separates cleanly whichever inks are chosen. Big flat shapes make the grain,
// the overprint and the mis-registration easy to see at a glance.
//
// paintPoster() is pure (no DOM), so it can be checked in Node.

export const SAMPLE_W = 900;
export const SAMPLE_H = 600;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Anti-aliased coverage from a signed distance in pixels (positive = inside). */
const edge = (d) => clamp01(d + 0.5);

const SUN = { x: 676, y: 256, r: 156 };
const DISC = { x: 454, y: 340, r: 128 };
const HORIZON = 432;
const RAYS = 18;

// "Type": a three-line headline and a few lines of body copy, as solid bars.
const HEADLINE = [
  [46, 44, 262, 40],
  [46, 96, 196, 40],
  [46, 148, 236, 40],
];
const BODY = [
  [48, 214, 170, 8],
  [48, 230, 150, 8],
  [48, 246, 176, 8],
  [48, 262, 118, 8],
];

function inRect(x, y, [rx, ry, rw, rh]) {
  const d = Math.min(x - rx, rx + rw - x, y - ry, ry + rh - y);
  return edge(d);
}
const inCircle = (x, y, c) => edge(c.r - Math.hypot(x - c.x, y - c.y));
const backHill = (x) => HORIZON + 22 * Math.sin(x / 96 + 0.4) + 12 * Math.sin(x / 41);
const frontHill = (x) => 506 + 26 * Math.sin(x / 120 + 2.2) + 9 * Math.sin(x / 53 + 1);

/** Coverage of ink A and ink B (0..1) at pixel centre (x, y). */
export function plates(x, y) {
  const sun = inCircle(x, y, SUN);
  const disc = inCircle(x, y, DISC);
  const back = edge(y - backHill(x));
  const front = edge(y - frontHill(x));
  let head = 0;
  for (const r of HEADLINE) head = Math.max(head, inRect(x, y, r));
  let body = 0;
  for (const r of BODY) body = Math.max(body, inRect(x, y, r));

  // Sky: a flat gradient tint of ink B, darker towards the horizon.
  const sky = 0.1 + 0.26 * clamp01(y / HORIZON);
  // Sun rays: alternate wedges of a light ink-A tint, fading out before the headline.
  const dist = Math.hypot(x - SUN.x, y - SUN.y);
  const wedge = Math.cos(Math.atan2(y - SUN.y, x - SUN.x) * RAYS) > 0.25 ? 1 : 0;
  const rays = wedge * 0.26 * edge(dist - SUN.r - 14) * clamp01((390 - dist) / 70) * (1 - disc);

  let a = Math.max(rays * (1 - back), sun * (1 - back));
  a = Math.max(a, 0.58 * back * (1 - front));
  a = Math.max(a, head, body);

  let b = sky * (1 - back) * (1 - sun);
  b = Math.max(b, disc * (1 - back));
  b = Math.max(b, front);
  b = Math.max(b, head);
  return [a, b];
}

/**
 * Paint the poster in inks A and B (sRGB triples) as RGBA pixels. Colours are
 * mixed in "absorption" (255 - value), the same model the separation uses.
 */
export function paintPoster(inkA, inkB, w = SAMPLE_W, h = SAMPLE_H) {
  const px = new Uint8ClampedArray(w * h * 4);
  const aa = inkA.map((v) => 255 - v);
  const ab = inkB.map((v) => 255 - v);
  const sx = SAMPLE_W / w;
  const sy = SAMPLE_H / h;
  let o = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [ca, cb] = plates((x + 0.5) * sx, (y + 0.5) * sy);
      px[o++] = 255 - (ca * aa[0] + cb * ab[0]);
      px[o++] = 255 - (ca * aa[1] + cb * ab[1]);
      px[o++] = 255 - (ca * aa[2] + cb * ab[2]);
      px[o++] = 255;
    }
  }
  return px;
}

/** The poster as a canvas, painted in the given ink pair. */
export function makeSample(inkA, inkB) {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(paintPoster(inkA, inkB), SAMPLE_W, SAMPLE_H), 0, 0);
  return canvas;
}
