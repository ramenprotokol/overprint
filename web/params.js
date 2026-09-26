// Job settings shared by the page and the tests.
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
