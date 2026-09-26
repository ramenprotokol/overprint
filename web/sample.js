// The built-in sample: a still life (three spheres on a striped cloth)
// painted procedurally, pixel by pixel. No photograph, no copyright.
//
// It only has to look like a photo; the print pipeline's determinism does
// not depend on it.

const W = 1200;
const H = 900;
const HORIZON = 600;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, v) => {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Far to near, so nearer spheres paint over farther ones.
const SPHERES = [
  { x: 790, y: 452, r: 150, rgb: [236, 196, 70] }, // lemon
  { x: 430, y: 520, r: 205, rgb: [226, 104, 118] }, // coral
  { x: 948, y: 648, r: 98, rgb: [66, 108, 186] }, // blue
];
const LIGHT = (() => {
  const v = [-0.55, -0.62, 0.56];
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
})();
const HALF = (() => {
  const v = [LIGHT[0], LIGHT[1], LIGHT[2] + 1];
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
})();

function background(x, y) {
  if (y < HORIZON) {
    // Wall: warm window light from the upper left, falling off to the right.
    const d = Math.hypot((x - 180) / W, (y - 60) / H);
    const wall = mix([252, 250, 245], [186, 180, 172], smooth(0.12, 1.15, d));
    // Soft shadow line where wall meets table.
    return mix(wall, [120, 110, 100], smooth(HORIZON - 70, HORIZON, y) * 0.35);
  }
  // Table cloth in perspective: stripes converge towards the vanishing point.
  const depth = (y - HORIZON) / (H - HORIZON); // 0 far .. 1 near
  const u = (x - W * 0.52) / (0.35 + 0.65 * depth);
  const stripe = smooth(0.35, 0.5, Math.abs(((u / 46) % 2 + 2) % 2 - 1));
  const cloth = mix([246, 243, 236], [88, 120, 150], stripe * 0.9);
  const lit = 0.78 + 0.22 * (1 - Math.hypot((x - 300) / W, (y - HORIZON) / (H - HORIZON)) * 0.7);
  return cloth.map((c) => c * lit);
}

function shadowAt(x, y) {
  let s = 0;
  for (const b of SPHERES) {
    const cx = b.x + b.r * 0.55;
    const cy = b.y + b.r * 0.94;
    const dx = (x - cx) / (b.r * 1.25);
    const dy = (y - cy) / (b.r * 0.3);
    const d = Math.hypot(dx, dy);
    s = Math.max(s, (1 - smooth(0.25, 1.05, d)) * 0.62);
  }
  return s;
}

function sphereAt(b, x, y) {
  const nx = (x - b.x) / b.r;
  const ny = (y - b.y) / b.r;
  const q = nx * nx + ny * ny;
  if (q > 1) return null;
  const nz = Math.sqrt(1 - q);
  const diff = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
  const spec = Math.pow(Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]), 48) * 0.85;
  // A little bounce light from the cloth on the underside.
  const bounce = Math.max(0, ny) * 0.12;
  const k = 0.16 + 0.9 * diff + bounce;
  const edge = smooth(0.985, 1, q); // anti-alias the rim
  return { rgb: b.rgb.map((c) => c * k + 255 * spec), edge };
}

/** Paint the still life into a new canvas. */
export function makeSample() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  let seed = 0x2f6b1d3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c = background(x, y);
      if (y >= HORIZON - 4) {
        const s = shadowAt(x, y);
        c = c.map((v) => v * (1 - s));
      }
      for (const b of SPHERES) {
        const hit = sphereAt(b, x, y);
        if (hit) c = mix(hit.rgb, c, hit.edge);
      }
      // Film-like grain so smooth areas do not band.
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const g = ((seed >>> 24) - 128) / 32;
      const o = (y * W + x) * 4;
      d[o] = c[0] + g;
      d[o + 1] = c[1] + g;
      d[o + 2] = c[2] + g;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
