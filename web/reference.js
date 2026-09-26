// overprint — plain-JavaScript reference implementation.
//
// A line-for-line port of the Rust core in src/. It exists for one reason: so
// the page can race the same job in WebAssembly and in plain JavaScript on
// your machine, and check that both produce the same bytes.
//
// Every step is integer arithmetic. Where Rust uses wrapping u32 maths we use
// Math.imul and >>>; where Rust uses arithmetic shifts on i32 we use >>; where
// Rust truncates an i64 division we use Math.trunc on values below 2^53, which
// doubles represent exactly.

export const PARAM_COUNT = 17;
export const MAX_REG = 16;
export const MAX_GRAIN = 100;
export const MAX_SIDE = 8192;
export const MAX_PIXELS = 16777216;
const PLATE_B_SALT = 0x9e3779b9;
const THRESHOLD = 128;

// ------------------------------------------------------------------ hash

export function hash3(x, y, s) {
  let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(s, 0xcb1ab31f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

// ------------------------------------------------------------ separation

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function separator(inkA, inkB) {
  const a0 = 255 - inkA[0], a1 = 255 - inkA[1], a2 = 255 - inkA[2];
  const b0 = 255 - inkB[0], b1 = 255 - inkB[1], b2 = 255 - inkB[2];
  const aa = a0 * a0 + a1 * a1 + a2 * a2;
  const bb = b0 * b0 + b1 * b1 + b2 * b2;
  const ab = a0 * b0 + a1 * b1 + a2 * b2;
  return { a0, a1, a2, b0, b1, b2, aa, bb, ab, det: aa * bb - ab * ab };
}

function separate(rgba, inkA, inkB, outA, outB) {
  const s = separator(inkA, inkB);
  const { a0, a1, a2, b0, b1, b2, aa, bb, ab, det } = s;
  const n = outA.length;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    const alpha = rgba[o + 3];
    if (alpha !== 255) {
      const k = 255 * (255 - alpha) + 127;
      r = ((r * alpha + k) / 255) | 0;
      g = ((g * alpha + k) / 255) | 0;
      b = ((b * alpha + k) / 255) | 0;
    }
    const x0 = 255 - r, x1 = 255 - g, x2 = 255 - b;
    const ax = a0 * x0 + a1 * x1 + a2 * x2;
    const bx = b0 * x0 + b1 * x1 + b2 * x2;
    let ca, cb;
    if (det <= 0) {
      if (aa > 0) { ca = clamp(Math.trunc((ax * 255) / aa), 0, 255); cb = 0; }
      else if (bb > 0) { ca = 0; cb = clamp(Math.trunc((bx * 255) / bb), 0, 255); }
      else { ca = 0; cb = 0; }
    } else {
      ca = Math.trunc(((bb * ax - ab * bx) * 255) / det);
      cb = Math.trunc(((aa * bx - ab * ax) * 255) / det);
      if (ca < 0 || ca > 255) {
        ca = clamp(ca, 0, 255);
        cb = clamp(Math.trunc((bx * 255 - ab * ca) / bb), 0, 255);
      } else if (cb < 0 || cb > 255) {
        cb = clamp(cb, 0, 255);
        ca = clamp(Math.trunc((ax * 255 - ab * cb) / aa), 0, 255);
      }
    }
    outA[i] = ca;
    outB[i] = cb;
  }
}

// ----------------------------------------------------------------- grain

function lattice(i, j, salt) {
  return (hash3(i, j, salt) & 255) - 128;
}

function coarse(x, y, salt) {
  const i = x >>> 4, j = y >>> 4, fx = x & 15, fy = y & 15;
  const top = lattice(i, j, salt) * (16 - fx) + lattice(i + 1, j, salt) * fx;
  const bot = lattice(i, j + 1, salt) * (16 - fx) + lattice(i + 1, j + 1, salt) * fx;
  return (top * (16 - fy) + bot * fy) >> 8;
}

function preparePlate(cov, w, density, grain, salt) {
  const coarseSalt = (salt ^ 0x68bc21eb) >>> 0;
  const out = new Int32Array(cov.length);
  for (let i = 0; i < cov.length; i++) {
    let v = Math.min(255, ((cov[i] * density) / 100) | 0);
    if (grain > 0 && v > 0) {
      const x = i % w, y = (i / w) | 0;
      const fine = (hash3(x, y, salt) & 255) - 128;
      const n = (fine >> 1) + coarse(x, y, coarseSalt);
      v = clamp(v + Math.trunc((n * grain * v) / 51200), 0, 255);
    }
    out[i] = v;
  }
  return out;
}

// ---------------------------------------------------------------- dither

function floydSteinberg(buf, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const rtl = (y & 1) === 1;
    const d = rtl ? -1 : 1;
    for (let s = 0; s < w; s++) {
      const x = rtl ? w - 1 - s : s;
      const i = y * w + x;
      const old = buf[i];
      const nv = old >= THRESHOLD ? 255 : 0;
      out[i] = nv === 255 ? 1 : 0;
      const err = old - nv;
      const e7 = (err * 7) >> 4, e3 = (err * 3) >> 4, e5 = (err * 5) >> 4;
      const e1 = err - e7 - e3 - e5;
      const xf = x + d, xb = x - d;
      const fOk = xf >= 0 && xf < w;
      if (fOk) buf[y * w + xf] += e7;
      if (y + 1 < h) {
        const row = (y + 1) * w;
        if (xb >= 0 && xb < w) buf[row + xb] += e3;
        buf[row + x] += e5;
        if (fOk) buf[row + xf] += e1;
      }
    }
  }
  return out;
}

const ATKINSON_TAPS = [[1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2]];

function atkinson(buf, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i];
      const nv = old >= THRESHOLD ? 255 : 0;
      out[i] = nv === 255 ? 1 : 0;
      const e = (old - nv) >> 3;
      for (let t = 0; t < 6; t++) {
        const nx = x + ATKINSON_TAPS[t][0], ny = y + ATKINSON_TAPS[t][1];
        if (nx >= 0 && nx < w && ny < h) buf[ny * w + nx] += e;
      }
    }
  }
  return out;
}

// Void-and-cluster blue noise, identical to src/dither.rs.
const BN = 64, BN_CELLS = BN * BN, BN_RADIUS = 6, BN_MAP_SEED = 0x0f0e1a5e;
const KERNEL = [
  65536, 52477, 42020, 33647, 26943, 21574, 17275, 13833, 11076, 8869, 7102, 5687, 4554, 3646,
  2920, 2338, 1872, 1499, 1200, 961, 770, 616, 493, 395, 316, 253, 203, 162, 130, 104, 83, 67,
  53, 43, 34, 27, 22, 18, 14, 11, 9, 7, 6, 5, 4, 3, 2, 2, 2, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

export function generateBlueNoise() {
  let on = new Uint8Array(BN_CELLS);
  let energy = new Int32Array(BN_CELLS);
  const toggle = (i, state) => {
    on[i] = state ? 1 : 0;
    const sign = state ? 1 : -1;
    const cx = i % BN, cy = (i / BN) | 0;
    for (let dy = -BN_RADIUS; dy <= BN_RADIUS; dy++) {
      const y = (cy + dy) & (BN - 1);
      for (let dx = -BN_RADIUS; dx <= BN_RADIUS; dx++) {
        const x = (cx + dx) & (BN - 1);
        energy[y * BN + x] += sign * KERNEL[dx * dx + dy * dy];
      }
    }
  };
  const tightest = () => {
    let best = -1, e = -Infinity;
    for (let i = 0; i < BN_CELLS; i++) if (on[i] && energy[i] > e) { e = energy[i]; best = i; }
    return best;
  };
  const largestVoid = () => {
    let best = -1, e = Infinity;
    for (let i = 0; i < BN_CELLS; i++) if (!on[i] && energy[i] < e) { e = energy[i]; best = i; }
    return best;
  };

  const initial = (BN_CELLS / 10) | 0;
  let placed = 0, k = 0;
  while (placed < initial) {
    const i = hash3(k, 0x5eed, BN_MAP_SEED) & (BN_CELLS - 1);
    k++;
    if (!on[i]) { toggle(i, true); placed++; }
  }
  for (let it = 0; it < 4 * BN_CELLS; it++) {
    const c = tightest();
    toggle(c, false);
    const v = largestVoid();
    if (v === c) { toggle(c, true); break; }
    toggle(v, true);
  }
  const protoOn = on.slice(), protoEnergy = energy.slice();
  const rank = new Uint16Array(BN_CELLS);
  for (let r = initial - 1; r >= 0; r--) {
    const c = tightest();
    toggle(c, false);
    rank[c] = r;
  }
  on = protoOn;
  energy = protoEnergy;
  for (let r = initial; r < BN_CELLS; r++) {
    const v = largestVoid();
    toggle(v, true);
    rank[v] = r;
  }
  return rank;
}

let cachedMap = null;
export function blueNoiseMap() {
  if (!cachedMap) cachedMap = generateBlueNoise();
  return cachedMap;
}

function blueNoise(buf, w, h, ox, oy) {
  const map = blueNoiseMap();
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = ((y + oy) & (BN - 1)) * BN;
    for (let x = 0; x < w; x++) {
      const r = map[row + ((x + ox) & (BN - 1))];
      out[y * w + x] = buf[y * w + x] * 8192 > (2 * r + 1) * 255 ? 1 : 0;
    }
  }
  return out;
}

function ditherPlate(buf, w, h, method, salt) {
  if (method === 0) return floydSteinberg(buf, w, h);
  if (method === 1) return atkinson(buf, w, h);
  return blueNoise(buf, w, h, hash3(1, 0, salt) & 63, hash3(2, 0, salt) & 63);
}

// --------------------------------------------------------------- compose

export function palette(paper, inkA, inkB) {
  const ab = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p = paper[c];
    ab[c] = p === 0 ? 0 : Math.min(255, Math.floor((inkA[c] * inkB[c] + Math.floor(p / 2)) / p));
  }
  return [paper, inkA, inkB, ab];
}

function compose(plateA, plateB, w, h, dx, dy, view, colors) {
  const showA = view !== 2, showB = view !== 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    const rowOk = sy >= 0 && sy < h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = showA && plateA[i] !== 0;
      const sx = x - dx;
      const b = showB && rowOk && sx >= 0 && sx < w && plateB[sy * w + sx] !== 0;
      const c = colors[(a ? 1 : 0) | (b ? 2 : 0)];
      const o = i * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------- render

export function parseParams(p) {
  if (!p || p.length !== PARAM_COUNT) {
    throw new Error(`expected ${PARAM_COUNT} parameters, got ${p ? p.length : 0}`);
  }
  const rgb = (o) => [clamp(p[o] | 0, 0, 255), clamp(p[o + 1] | 0, 0, 255), clamp(p[o + 2] | 0, 0, 255)];
  const dither = p[9] | 0;
  if (dither < 0 || dither > 2) throw new Error(`unknown dither method ${dither}`);
  const view = p[16] | 0;
  if (view < 0 || view > 2) throw new Error(`unknown view ${view}`);
  return {
    inkA: rgb(0), inkB: rgb(3), paper: rgb(6), dither,
    regX: clamp(p[10] | 0, -MAX_REG, MAX_REG),
    regY: clamp(p[11] | 0, -MAX_REG, MAX_REG),
    grain: clamp(p[12] | 0, 0, MAX_GRAIN),
    densityA: clamp(p[13] | 0, 0, 200),
    densityB: clamp(p[14] | 0, 0, 200),
    seed: p[15] >>> 0,
    view,
  };
}

/** Same contract as the WebAssembly `render`: RGBA in, RGBA out. */
export function render(rgba, w, h, params) {
  const p = parseParams(params);
  if (!w || !h) throw new Error('image is empty');
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) throw new Error(`image too large (${w}x${h})`);
  if (rgba.length !== w * h * 4) throw new Error(`expected ${w * h * 4} bytes of RGBA, got ${rgba.length}`);
  const n = w * h;
  const covA = new Uint8Array(n), covB = new Uint8Array(n);
  separate(rgba, p.inkA, p.inkB, covA, covB);
  const saltA = p.seed, saltB = (p.seed ^ PLATE_B_SALT) >>> 0;
  const bufA = preparePlate(covA, w, p.densityA, p.grain, saltA);
  const bufB = preparePlate(covB, w, p.densityB, p.grain, saltB);
  const plateA = ditherPlate(bufA, w, h, p.dither, saltA);
  const plateB = ditherPlate(bufB, w, h, p.dither, saltB);
  return compose(plateA, plateB, w, h, p.regX, p.regY, p.view, palette(p.paper, p.inkA, p.inkB));
}
