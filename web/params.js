// Job settings and size maths shared by the page and the tests.
//
// Ink colours are on-screen sRGB approximations of common stencil-printing
// spot inks, chosen by eye. They are not any maker's official values.

export const PAPER = [244, 240, 230]; // #F4F0E6, the sheet colour in styles.css

export const PRESETS = {
  'pink-blue': {
    label: 'Fluorescent pink + Blue',
    a: { name: 'Fluo pink', rgb: [255, 72, 176] },
    b: { name: 'Blue', rgb: [0, 120, 191] },
  },
  'teal-yellow': {
    label: 'Teal + Yellow',
    a: { name: 'Teal', rgb: [0, 131, 138] },
    b: { name: 'Yellow', rgb: [255, 232, 0] },
  },
  'red-black': {
    label: 'Red + Black',
    a: { name: 'Red', rgb: [232, 64, 58] },
    b: { name: 'Black', rgb: [34, 32, 34] },
  },
};

export const DITHERS = ['fs', 'atkinson', 'blue'];
/** Dots on the long edge the ticket offers. */
export const DOT_SIZES = [400, 600, 900];
/** Exports are at least this many pixels on the long edge. */
export const EXPORT_MIN_EDGE = 2400;

/**
 * Export size for a print of w × h dots. Every dot becomes a k × k block of
 * whole pixels (nearest-neighbour, so dots stay crisp squares), with the
 * smallest k that makes the long edge at least EXPORT_MIN_EDGE:
 * 2400 px at 400 or 600 dots, 2700 px at 900.
 */
export function exportSize(w, h) {
  const long = Math.max(w, h);
  const k = long > 0 ? Math.max(1, Math.ceil(EXPORT_MIN_EDGE / long)) : 1;
  return { k, width: w * k, height: h * k };
}

const MARGIN_MIN = 14;

/**
 * Preview size for a print of w × h dots on a bed of bw × bh CSS px.
 * Prefers a whole number of device pixels per dot, so every dot is drawn the
 * same size and the grain stays crisp; the sheet margin may shrink (to 14 px)
 * to make room for that. Falls back to a plain fit only when whole pixels would
 * show the print at under 70% of the size that fits (dpr-2 phones at 400 dots).
 * Returns CSS sizes, the margin m, device pixels per dot and whether it is whole.
 */
export function fitPreview(bw, bh, w, h, dpr = 1) {
  const pref = Math.round(Math.min(52, Math.max(24, Math.min(bw, bh) * 0.07)));
  const fit = Math.max(0, Math.min((bw - 2 * pref) / w, (bh - 2 * pref) / h));
  const room = Math.max(0, Math.min((bw - 2 * MARGIN_MIN) / w, (bh - 2 * MARGIN_MIN) / h));
  const k = Math.floor(room * dpr + 1e-9);
  if (k >= 1 && k / dpr >= 0.7 * fit) {
    const iw = (w * k) / dpr;
    const ih = (h * k) / dpr;
    const m = Math.max(MARGIN_MIN, Math.min(pref, Math.floor(Math.min((bw - iw) / 2, (bh - ih) / 2))));
    return { iw, ih, m, perDot: k, whole: true };
  }
  const iw = Math.max(40, Math.floor(w * fit));
  const ih = Math.max(30, Math.floor(h * fit));
  return { iw, ih, m: pref, perDot: (iw / w) * dpr, whole: false };
}
export const VIEWS = ['composite', 'a', 'b'];

/** Flatten a job into the 17-slot Int32Array both engines read. */
export function encodeParams(job) {
  const preset = PRESETS[job.preset];
  const p = new Int32Array(17);
  p.set(preset.a.rgb, 0);
  p.set(preset.b.rgb, 3);
  p.set(PAPER, 6);
  p[9] = DITHERS.indexOf(job.dither);
  p[10] = job.regX;
  p[11] = job.regY;
  p[12] = job.grain;
  p[13] = job.densityA;
  p[14] = job.densityB;
  p[15] = job.seed | 0;
  p[16] = VIEWS.indexOf(job.view);
  return p;
}

export const toHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
