//! overprint — two-ink risograph-style printing, in Rust, for WebAssembly.
//!
//! Pipeline for one job:
//! 1. `separate`  — split the photo into ink A / ink B coverage (least squares).
//! 2. `grain`     — apply plate density and seeded ink grain.
//! 3. `dither`    — Floyd–Steinberg, Atkinson or blue-noise, per plate.
//! 4. `compose`   — offset plate B (mis-registration) and overprint the
//!    inks multiplicatively on paper.
//!
//! All maths is integer-only and seeded, so the output is identical on every
//! machine, and identical to the plain-JavaScript reference in `web/reference.js`.

pub mod compose;
pub mod dither;
pub mod grain;
pub mod hash;
pub mod separate;

use compose::View;
use wasm_bindgen::prelude::*;

/// Number of i32 slots in the flat parameter array shared with JavaScript.
pub const PARAM_COUNT: usize = 17;
pub const MAX_SIDE: usize = 8192;
pub const MAX_PIXELS: usize = 16_777_216;

/// Salt that separates plate B's randomness from plate A's.
pub const PLATE_B_SALT: u32 = 0x9e37_79b9;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dither {
    FloydSteinberg,
    Atkinson,
    BlueNoise,
}

#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub ink_a: [u8; 3],
    pub ink_b: [u8; 3],
    pub paper: [u8; 3],
    pub dither: Dither,
    pub reg_x: i32,
    pub reg_y: i32,
    pub grain: i32,
    pub density_a: i32,
    pub density_b: i32,
    pub seed: u32,
    pub view: View,
}

impl Params {
    /// Layout: inkA rgb, inkB rgb, paper rgb, dither, regX, regY, grain,
    /// densityA, densityB, seed, view. Out-of-range numbers are clamped;
    /// unknown dither / view codes are an error.
    pub fn from_slice(p: &[i32]) -> Result<Params, String> {
        if p.len() != PARAM_COUNT {
            return Err(format!(
                "expected {PARAM_COUNT} parameters, got {}",
                p.len()
            ));
        }
        let rgb = |o: usize| [0, 1, 2].map(|k| p[o + k].clamp(0, 255) as u8);
        let dither = match p[9] {
            0 => Dither::FloydSteinberg,
            1 => Dither::Atkinson,
            2 => Dither::BlueNoise,
            d => return Err(format!("unknown dither method {d}")),
        };
        let view = match p[16] {
            0 => View::Composite,
            1 => View::PlateA,
            2 => View::PlateB,
            v => return Err(format!("unknown view {v}")),
        };
        Ok(Params {
            ink_a: rgb(0),
            ink_b: rgb(3),
            paper: rgb(6),
            dither,
            reg_x: compose::clamp_reg(p[10]),
            reg_y: compose::clamp_reg(p[11]),
            grain: p[12].clamp(0, grain::MAX_GRAIN),
            density_a: p[13].clamp(0, 200),
            density_b: p[14].clamp(0, 200),
            seed: p[15] as u32,
            view,
        })
    }
}

fn dither_plate(buf: &mut [i32], w: usize, h: usize, method: Dither, salt: u32) -> Vec<u8> {
    match method {
        Dither::FloydSteinberg => dither::floyd_steinberg(buf, w, h),
        Dither::Atkinson => dither::atkinson(buf, w, h),
        Dither::BlueNoise => {
            let ox = (hash::hash3(1, 0, salt) & 63) as usize;
            let oy = (hash::hash3(2, 0, salt) & 63) as usize;
            dither::blue_noise(buf, w, h, ox, oy)
        }
    }
}

/// Run the whole job on an RGBA buffer. Returns an RGBA buffer of the same size.
pub fn render_rgba(rgba: &[u8], w: usize, h: usize, p: &Params) -> Result<Vec<u8>, String> {
    if w == 0 || h == 0 {
        return Err("image is empty".into());
    }
    if w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS {
        return Err(format!("image too large ({w}x{h})"));
    }
    if rgba.len() != w * h * 4 {
        return Err(format!(
            "expected {} bytes of RGBA, got {}",
            w * h * 4,
            rgba.len()
        ));
    }
    let n = w * h;
    let mut cov_a = vec![0u8; n];
    let mut cov_b = vec![0u8; n];
    separate::separate(rgba, p.ink_a, p.ink_b, &mut cov_a, &mut cov_b);

    let salt_a = p.seed;
    let salt_b = p.seed ^ PLATE_B_SALT;
    let mut buf_a = grain::prepare_plate(&cov_a, w, p.density_a, p.grain, salt_a);
    let mut buf_b = grain::prepare_plate(&cov_b, w, p.density_b, p.grain, salt_b);
    let plate_a = dither_plate(&mut buf_a, w, h, p.dither, salt_a);
    let plate_b = dither_plate(&mut buf_b, w, h, p.dither, salt_b);

    let colors = compose::palette(p.paper, p.ink_a, p.ink_b);
    Ok(compose::compose(
        &plate_a, &plate_b, w, h, p.reg_x, p.reg_y, p.view, colors,
    ))
}

// ---------------------------------------------------------------- wasm API

/// Render one job. `params` uses the layout documented on `Params::from_slice`.
#[wasm_bindgen]
pub fn render(rgba: &[u8], width: u32, height: u32, params: &[i32]) -> Result<Vec<u8>, JsError> {
    let p = Params::from_slice(params).map_err(|e| JsError::new(&e))?;
    render_rgba(rgba, width as usize, height as usize, &p).map_err(|e| JsError::new(&e))
}

/// Build the blue-noise threshold map ahead of time (it is cached).
#[wasm_bindgen]
pub fn prepare() {
    let _ = dither::blue_noise_map();
}

/// The 64x64 blue-noise rank map, for tests and for curious readers.
#[wasm_bindgen(js_name = blueNoiseMap)]
pub fn blue_noise_map_js() -> Vec<u16> {
    dither::blue_noise_map().to_vec()
}

#[wasm_bindgen(js_name = paramCount)]
pub fn param_count() -> u32 {
    PARAM_COUNT as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn params(dither: i32, grain: i32, reg: (i32, i32), seed: i32) -> Vec<i32> {
        vec![
            255, 72, 176, 0, 120, 191, 244, 240, 230, dither, reg.0, reg.1, grain, 100, 100, seed,
            0,
        ]
    }

    #[test]
    fn rejects_bad_input() {
        let p = Params::from_slice(&params(0, 0, (0, 0), 1)).unwrap();
        assert!(render_rgba(&[0; 15], 2, 2, &p).is_err());
        assert!(render_rgba(&[], 0, 0, &p).is_err());
        assert!(render_rgba(&[0; 4], 9000, 1, &p).is_err());
        assert!(Params::from_slice(&[0; 3]).is_err());
        assert!(Params::from_slice(&params(9, 0, (0, 0), 1)).is_err());
        let mut bad_view = params(0, 0, (0, 0), 1);
        bad_view[16] = 3;
        assert!(Params::from_slice(&bad_view).is_err());
    }

    #[test]
    fn params_are_clamped() {
        let mut raw = params(2, 999, (99, -99), -1);
        raw[0] = 400;
        raw[13] = -5;
        let p = Params::from_slice(&raw).unwrap();
        assert_eq!(p.ink_a[0], 255);
        assert_eq!(p.grain, 100);
        assert_eq!((p.reg_x, p.reg_y), (16, -16));
        assert_eq!(p.density_a, 0);
        assert_eq!(p.seed, u32::MAX);
    }
}
