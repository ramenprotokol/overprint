// overprint — page controller. All image processing happens in the Rust core
// (./pkg, WebAssembly). ./reference.js is only used for the speed race and
// as a clearly labelled fallback if WebAssembly cannot load.
import init, { render as wasmRender, prepare } from './pkg/overprint.js';
import * as ref from './reference.js';
import { PRESETS, PAPER, encodeParams, toHex, exportSize, fitPreview } from './params.js';
import { makeSample } from './sample.js';
import { checkFile, pixelProblem, decodeFailure, workingSize } from './intake.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const RUNS = 7;
const MINUS = '−';

const DITHER_NAMES = { fs: 'Floyd–Steinberg', atkinson: 'Atkinson', blue: 'Blue noise' };
const state = {
  preset: 'pink-blue',
  dither: 'fs',
  dots: 400,
  regX: 2,
  regY: -1,
  grain: 35,
  densityA: 100,
  densityB: 100,
  seed: 417,
  view: 'composite',
};

let engine = null; // { kind: 'wasm' | 'js', render }
let source = null; // { image: canvas (long edge ≤ 900), width, height (as decoded), label, kind }
let input = null; // { data, w, h, dots, source }
let last = null; // { w, h, ms }
let pending = false;
let raceToken = 0;
let raceTimer = 0;
let loadToken = 0;

root.dataset.state = 'loading';
root.dataset.errors = '0';
window.addEventListener('error', () => (root.dataset.errors = String(Number(root.dataset.errors) + 1)));
window.addEventListener('unhandledrejection', () => (root.dataset.errors = String(Number(root.dataset.errors) + 1)));

// ------------------------------------------------------------------ helpers

const signed = (v) => (v > 0 ? `+${v}` : v < 0 ? `${MINUS}${-v}` : '0');
const pad4 = (n) => String(n).padStart(4, '0');
const ms = (v) => (v < 10 ? v.toFixed(1) : v.toFixed(0)) + ' ms';
const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function store(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable: fine */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = false;
}
function clearError() {
  $('error').hidden = true;
  $('error').textContent = '';
}

// -------------------------------------------------------------------- room

function applyRoom(choice) {
  if (choice) root.dataset.theme = choice;
  else delete root.dataset.theme;
  const effective = choice || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  for (const r of document.querySelectorAll('input[name=room]')) r.checked = r.value === effective;
}

function setupRoom() {
  applyRoom(recall('overprint.room'));
  for (const r of document.querySelectorAll('input[name=room]')) {
    r.addEventListener('change', () => {
      store('overprint.room', r.value);
      applyRoom(r.value);
    });
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyRoom(recall('overprint.room')));
}

// ----------------------------------------------------------------- ticket

function inkColours() {
  const p = PRESETS[state.preset];
  const pal = ref.palette(PAPER, p.a.rgb, p.b.rgb);
  return { a: toHex(p.a.rgb), b: toHex(p.b.rgb), ab: toHex(pal[3]), paper: toHex(PAPER), p };
}

function buildPresets() {
  const box = $('presets');
  for (const [key, p] of Object.entries(PRESETS)) {
    const pal = ref.palette(PAPER, p.a.rgb, p.b.rgb);
    const label = document.createElement('label');
    label.className = 'preset';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'preset';
    input.value = key;
    input.checked = key === state.preset;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.setAttribute('aria-hidden', 'true');
    for (const [cls, rgb] of [['ca', p.a.rgb], ['cb', p.b.rgb], ['cab', pal[3]]]) {
      const i = document.createElement('i');
      i.className = cls;
      i.style.background = toHex(rgb);
      chip.append(i);
    }
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.label;
    label.append(input, chip, name);
    box.append(label);
  }
}

function syncInks() {
  const c = inkColours();
  root.style.setProperty('--ink-a', c.a);
  root.style.setProperty('--ink-b', c.b);
  root.style.setProperty('--ink-ab', c.ab);
  $('name-a').textContent = c.p.a.name;
  $('name-b').textContent = c.p.b.name;
  const bar = $('bar').children;
  [c.paper, c.a, c.b, c.ab].forEach((hex, i) => (bar[i].style.background = hex));
}

function syncOutputs() {
  $('density-a-out').textContent = `${state.densityA}%`;
  $('density-b-out').textContent = `${state.densityB}%`;
  $('reg-x-out').textContent = signed(state.regX);
  $('reg-y-out').textContent = signed(state.regY);
  $('grain-out').textContent = String(state.grain);
  $('seed-out').textContent = pad4(state.seed);
  $('reg-x').value = state.regX;
  $('reg-y').value = state.regY;
  root.style.setProperty('--reg-x', state.regX);
  root.style.setProperty('--reg-y', state.regY);
}

function bindTicket() {
  const onRadio = (name, key, cast = (v) => v) => {
    for (const r of document.querySelectorAll(`input[name=${name}]`)) {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        state[key] = cast(r.value);
        if (key === 'preset') {
          syncInks();
          if (source?.kind === 'sample') useSample({ feed: false });
        }
        if (key === 'dots') input = null;
        schedule();
      });
    }
  };
  onRadio('preset', 'preset');
  onRadio('dither', 'dither');
  onRadio('dots', 'dots', Number);
  onRadio('view', 'view');

  const onRange = (id, key) => {
    $(id).addEventListener('input', () => {
      state[key] = Number($(id).value);
      syncOutputs();
      schedule();
    });
  };
  onRange('density-a', 'densityA');
  onRange('density-b', 'densityB');
  onRange('reg-x', 'regX');
  onRange('reg-y', 'regY');
  onRange('grain', 'grain');

  $('align').addEventListener('click', () => {
    state.regX = 0;
    state.regY = 0;
    syncOutputs();
    schedule();
  });
  $('reseed').addEventListener('click', () => {
    let next = state.seed;
    while (next === state.seed) next = 1 + Math.floor(Math.random() * 9999);
    state.seed = next;
    syncOutputs();
    schedule();
  });

  $('choose').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', () => {
    const f = $('file').files[0];
    $('file').value = '';
    loadFile(f);
  });
  $('sample').addEventListener('click', () => useSample());
  $('export').addEventListener('click', exportPng);
  $('race').addEventListener('change', () => {
    $('race-panel').hidden = !$('race').checked;
    if ($('race').checked) runRace();
    else raceToken++;
  });
}

// ----------------------------------------------------------------- sources

function setSource(src, { feed = true } = {}) {
  source = src;
  input = null;
  $('source-meta').textContent = `${src.label} · ${src.width} × ${src.height} px`;
  $('source-meta').title = src.label;
  const sheet = $('sheet');
  if (feed && !reducedMotion()) {
    sheet.classList.remove('feed');
    void sheet.offsetWidth;
    sheet.classList.add('feed');
  }
  schedule();
}

// The sample poster is drawn as two plates and painted in the current inks,
// so it is repainted when the ink pair changes.
function useSample({ feed = true } = {}) {
  loadToken++;
  clearError();
  const p = PRESETS[state.preset];
  const canvas = makeSample(p.a.rgb, p.b.rgb);
  setSource({ image: canvas, width: canvas.width, height: canvas.height, label: 'Sample poster, drawn in code', kind: 'sample' }, { feed });
}

// Draw the decoded photo once into a working canvas no bigger than the
// largest dot count, then release the full-size decode.
function workingCopy(bitmap) {
  const { width, height } = workingSize(bitmap.width, bitmap.height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return c;
}

async function loadFile(file) {
  clearError();
  if (!file) return;
  const token = ++loadToken;
  // Format and pixel size, read in small bounded pieces before any decoding.
  const { format, problem } = await checkFile(file);
  if (token !== loadToken) return; // another file (or the sample) came in meanwhile
  if (problem) {
    showError(problem);
    return;
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (token === loadToken) showError(decodeFailure(file.name, format));
    return;
  }
  const { width, height } = bitmap;
  const tooBig = pixelProblem(file.name, width, height);
  if (tooBig || token !== loadToken) {
    bitmap.close();
    if (tooBig && token === loadToken) showError(tooBig);
    return;
  }
  setSource({ image: workingCopy(bitmap), width, height, label: file.name || 'Pasted image', kind: 'photo' });
}

function prepareInput() {
  if (input && input.source === source && input.dots === state.dots) return input;
  // Output size comes from the photo's own proportions; pixels come from the working copy.
  const scale = state.dots / Math.max(source.width, source.height);
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source.image, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  input = { data: new Uint8Array(px.buffer, px.byteOffset, px.length), w, h, dots: state.dots, source };
  return input;
}

// ----------------------------------------------------------------- render

function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    renderNow();
  });
}

function renderNow() {
  if (!engine || !source) return;
  const job = prepareInput();
  const params = encodeParams(state);
  let out;
  const t0 = performance.now();
  try {
    out = engine.render(job.data, job.w, job.h, params);
  } catch (e) {
    showError(`The print run failed: ${e && e.message ? e.message : e}`);
    return;
  }
  const took = performance.now() - t0;
  const canvas = $('print');
  if (canvas.width !== job.w || canvas.height !== job.h) {
    canvas.width = job.w;
    canvas.height = job.h;
  }
  const img = new ImageData(new Uint8ClampedArray(out.buffer, out.byteOffset, out.length), job.w, job.h);
  canvas.getContext('2d').putImageData(img, 0, 0);
  last = { w: job.w, h: job.h, ms: took };
  describe();
  layout();
  root.dataset.state = 'rendered';
  if ($('race').checked) {
    clearTimeout(raceTimer);
    raceToken++;
    $('verdict').textContent = 'Settings changed. Measuring again…';
    raceTimer = setTimeout(runRace, 450);
  }
}

function describe() {
  const c = inkColours();
  const who = engine.kind === 'wasm' ? 'Rust → WebAssembly' : 'plain JavaScript (WebAssembly didn’t load)';
  $('render-meta').textContent = `This print: ${ms(last.ms)} in ${who}, one run on this device.`;
  const out = exportSize(last.w, last.h);
  $('export-meta').textContent = `${out.width} × ${out.height} px`;
  const view = state.view === 'a' ? ' · proof A' : state.view === 'b' ? ' · proof B' : '';
  $('slug-text').textContent = `${c.p.a.name} / ${c.p.b.name} · ${DITHER_NAMES[state.dither]} · ${last.w}×${last.h} dots · ${ms(last.ms)}${view}`;
  $('slug-job').textContent = `overprint ${pad4(state.seed)}`;
  $('print').setAttribute(
    'aria-label',
    `Two-ink print of ${source.label}: ${c.p.a.name} and ${c.p.b.name}, ${DITHER_NAMES[state.dither]} dithering, plate B offset ${signed(state.regX)}, ${signed(state.regY)} dots.`,
  );
}

// ----------------------------------------------------------------- layout

function layout() {
  if (!last) return;
  const bed = $('bed');
  const sheet = $('sheet');
  const canvas = $('print');
  const wide = matchMedia('(min-width: 960px)').matches;
  const bw = bed.clientWidth;
  const bh = wide ? bed.clientHeight - 36 : Math.round(innerHeight * 0.78);
  // Whole device pixels per dot where possible, so the grain is crisp.
  const { iw, ih, m, perDot, whole } = fitPreview(bw, bh, last.w, last.h, devicePixelRatio || 1);
  const sw = iw + 2 * m;
  const sh = ih + 2 * m;
  sheet.style.width = `${sw}px`;
  sheet.style.height = `${sh}px`;
  sheet.style.setProperty('--m', `${m}px`);
  canvas.style.width = `${iw}px`;
  canvas.style.height = `${ih}px`;
  canvas.classList.toggle('crisp', perDot >= 1);
  root.dataset.preview = whole ? `${perDot}` : 'fit';
  drawMarks(sw, sh, m, iw / last.w);
}

function drawMarks(W, H, m, dotPx) {
  const svg = $('marks');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  const gap = Math.max(4, Math.round(m * 0.14));
  const len = Math.max(8, Math.min(22, m - gap - 6));
  const x0 = m, y0 = m, x1 = W - m, y1 = H - m;
  let d = '';
  const line = (ax, ay, bx, by) => (d += `M${ax} ${ay}L${bx} ${by}`);
  // Crop marks: two ticks per corner, sitting just outside the trim.
  for (const [cx, sx] of [[x0, -1], [x1, 1]]) {
    for (const [cy, sy] of [[y0, -1], [y1, 1]]) {
      line(cx + sx * gap, cy, cx + sx * (gap + len), cy);
      line(cx, cy + sy * gap, cx, cy + sy * (gap + len));
    }
  }
  // Registration targets: top centre, left middle, right middle.
  const r = Math.max(4, Math.min(7.5, m * 0.18));
  const targets = [[W / 2, m / 2], [m / 2, H / 2], [W - m / 2, H / 2]];
  let circles = '';
  for (const [tx, ty] of targets) {
    line(tx - r * 1.7, ty, tx + r * 1.7, ty);
    line(tx, ty - r * 1.7, tx, ty + r * 1.7);
    circles += `<circle cx="${tx}" cy="${ty}" r="${r}"/>`;
  }
  const c = inkColours();
  const plate = (colour, tx, ty) =>
    `<g class="plate" stroke="${colour}" fill="none" transform="translate(${tx} ${ty})"><path d="${d}"/>${circles}</g>`;
  const dx = +(state.regX * dotPx).toFixed(2);
  const dy = +(state.regY * dotPx).toFixed(2);
  svg.innerHTML = plate(c.a, 0, 0) + plate(c.b, dx, dy);
}

// ----------------------------------------------------------------- export

function exportPng() {
  if (!last) return;
  const src = $('print');
  const out = exportSize(last.w, last.h);
  const c = document.createElement('canvas');
  c.width = out.width;
  c.height = out.height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  c.toBlob((blob) => {
    if (!blob) {
      showError('The browser could not create the PNG. Try a smaller dot count.');
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `overprint-${state.preset}-${state.dither}-${pad4(state.seed)}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
}

// ------------------------------------------------------------------- race

async function runRace() {
  const token = ++raceToken;
  const set = (id, v) => ($(id).textContent = v);
  for (const id of ['t-wasm', 't-js', 'n-wasm', 'n-js']) set(id, '…');
  set('identical', '');
  if (engine.kind !== 'wasm') {
    set('verdict', 'The race needs the WebAssembly engine, and it did not load in this browser.');
    return;
  }
  if (!source) return;
  set('verdict', 'Measuring…');
  await frame();
  if (token !== raceToken) return;
  const job = prepareInput();
  const p = encodeParams(state);
  // Warm-up run for each engine (also builds each engine's blue-noise map).
  wasmRender(job.data, job.w, job.h, p);
  ref.render(job.data, job.w, job.h, p);
  const tw = [];
  const tj = [];
  let ow, oj;
  for (let i = 0; i < RUNS; i++) {
    await frame();
    if (token !== raceToken) return;
    const order = i % 2 === 0 ? ['wasm', 'js'] : ['js', 'wasm'];
    for (const who of order) {
      const t0 = performance.now();
      if (who === 'wasm') ow = wasmRender(job.data, job.w, job.h, p);
      else oj = ref.render(job.data, job.w, job.h, p);
      (who === 'wasm' ? tw : tj).push(performance.now() - t0);
    }
  }
  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const mw = median(tw);
  const mj = median(tj);
  set('t-wasm', ms(mw));
  set('t-js', ms(mj));
  set('n-wasm', String(tw.length));
  set('n-js', String(tj.length));
  const ratio = mj / Math.max(mw, 1e-3);
  if (ratio >= 1.1) set('verdict', `On this device, WebAssembly finished this job ${ratio.toFixed(1)}× faster than plain JavaScript.`);
  else if (ratio <= 1 / 1.1) set('verdict', `On this device, plain JavaScript was ${(1 / ratio).toFixed(1)}× faster this time.`);
  else set('verdict', 'On this device, both engines took about the same time.');
  let diff = -1;
  if (ow.length !== oj.length) diff = Math.min(ow.length, oj.length);
  else for (let i = 0; i < ow.length; i++) if (ow[i] !== oj[i]) { diff = i; break; }
  set('identical', diff < 0
    ? `Identical output: all ${ow.length.toLocaleString('en')} bytes match (${job.w}×${job.h} dots).`
    : `Outputs differ from byte ${diff.toLocaleString('en')}. That is a bug; the tests say this should never happen.`);
}

// ------------------------------------------------------------ drag & drop

function setupDrop() {
  const veil = $('veil');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    veil.hidden = false;
  });
  addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) veil.hidden = true;
  });
  addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    veil.hidden = true;
    loadFile(e.dataTransfer.files[0]);
  });
  addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file');
    if (item) loadFile(item.getAsFile());
  });
}

// ------------------------------------------------------------------- boot

async function boot() {
  setupRoom();
  buildPresets();
  syncInks();
  syncOutputs();
  bindTicket();
  setupDrop();
  new ResizeObserver(() => layout()).observe($('bed'));
  try {
    await init();
    prepare();
    engine = { kind: 'wasm', render: wasmRender };
  } catch (e) {
    console.warn('WebAssembly unavailable, using the plain-JavaScript engine.', e);
    engine = { kind: 'js', render: ref.render };
  }
  root.dataset.engine = engine.kind;
  useSample();
}

boot();
