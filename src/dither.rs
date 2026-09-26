//! Dithering: turn a coverage plane (0..=255 per pixel) into ink / no ink.
//!
//! * Floyd–Steinberg, serpentine scan, error split 7/3/5/1 (sixteenths).
//!   The four shares always add up to the full error.
//! * Atkinson: six neighbours each get 1/8 of the error; 2/8 is dropped on
//!   purpose, which gives its crisp, high-contrast look.
//! * Blue noise: an ordered threshold against a 64x64 void-and-cluster rank
//!   map that is generated here, in code, from a fixed seed.
//!
//! Error shares use arithmetic right shifts (floor), which JavaScript's `>>`
//! matches exactly on 32-bit integers.

use crate::hash::hash3;
use std::sync::OnceLock;

/// Ink goes down when the (error-adjusted) value reaches this level.
pub const THRESHOLD: i32 = 128;

/// Floyd–Steinberg with a serpentine scan. `buf` is consumed as the working
/// error buffer. Returns 1 for ink, 0 for paper.
pub fn floyd_steinberg(buf: &mut [i32], w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        let rtl = y % 2 == 1;
        for step in 0..w {
            let x = if rtl { w - 1 - step } else { step };
            let i = y * w + x;
            let old = buf[i];
            let new = if old >= THRESHOLD { 255 } else { 0 };
            out[i] = (new == 255) as u8;
            let err = old - new;
            let e7 = (err * 7) >> 4;
            let e3 = (err * 3) >> 4;
            let e5 = (err * 5) >> 4;
            let e1 = err - e7 - e3 - e5;
            // "forward" is the scan direction on this row.
            let fwd = |dx: isize| -> Option<usize> {
                let nx = x as isize + if rtl { -dx } else { dx };
                (nx >= 0 && (nx as usize) < w).then_some(nx as usize)
            };
            if let Some(nx) = fwd(1) {
                buf[y * w + nx] += e7;
            }
            if y + 1 < h {
                let row = (y + 1) * w;
                if let Some(nx) = fwd(-1) {
                    buf[row + nx] += e3;
                }
                buf[row + x] += e5;
                if let Some(nx) = fwd(1) {
                    buf[row + nx] += e1;
                }
            }
        }
    }
    out
}

/// Atkinson dithering, left-to-right raster scan.
pub fn atkinson(buf: &mut [i32], w: usize, h: usize) -> Vec<u8> {
    let mut out = vec![0u8; w * h];
    const TAPS: [(isize, usize); 6] = [(1, 0), (2, 0), (-1, 1), (0, 1), (1, 1), (0, 2)];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let old = buf[i];
            let new = if old >= THRESHOLD { 255 } else { 0 };
            out[i] = (new == 255) as u8;
            let e = (old - new) >> 3;
            for (dx, dy) in TAPS {
                let nx = x as isize + dx;
                let ny = y + dy;
                if nx >= 0 && (nx as usize) < w && ny < h {
                    buf[ny * w + nx as usize] += e;
                }
            }
        }
    }
    out
}

pub const BN_SIZE: usize = 64;
const BN_CELLS: usize = BN_SIZE * BN_SIZE;
const BN_RADIUS: isize = 6;
/// Seed of the one-off random starting pattern for the threshold map.
pub const BN_MAP_SEED: u32 = 0x0f0e_1a5e;

/// round(65536 * exp(-d2 / (2 * 1.5^2))) for d2 = 0..=72: a Gaussian with
/// sigma 1.5, stored as integers so JS and Rust agree bit for bit.
const KERNEL: [i32; 73] = [
    65536, 52477, 42020, 33647, 26943, 21574, 17275, 13833, 11076, 8869, 7102, 5687, 4554, 3646,
    2920, 2338, 1872, 1499, 1200, 961, 770, 616, 493, 395, 316, 253, 203, 162, 130, 104, 83, 67,
    53, 43, 34, 27, 22, 18, 14, 11, 9, 7, 6, 5, 4, 3, 2, 2, 2, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

struct Field {
    on: Vec<bool>,
    energy: Vec<i32>,
}

impl Field {
    fn toggle(&mut self, i: usize, on: bool) {
        self.on[i] = on;
        let sign = if on { 1 } else { -1 };
        let (cx, cy) = ((i % BN_SIZE) as isize, (i / BN_SIZE) as isize);
        let n = BN_SIZE as isize;
        for dy in -BN_RADIUS..=BN_RADIUS {
            let y = (cy + dy).rem_euclid(n) as usize;
            for dx in -BN_RADIUS..=BN_RADIUS {
                let x = (cx + dx).rem_euclid(n) as usize;
                self.energy[y * BN_SIZE + x] += sign * KERNEL[(dx * dx + dy * dy) as usize];
            }
        }
    }

    /// Tightest cluster: the "on" cell with the most energy (first on ties).
    fn tightest(&self) -> usize {
        let mut best = usize::MAX;
        let mut e = i32::MIN;
        for i in 0..BN_CELLS {
            if self.on[i] && self.energy[i] > e {
                e = self.energy[i];
                best = i;
            }
        }
        best
    }

    /// Largest void: the "off" cell with the least energy (first on ties).
    fn largest_void(&self) -> usize {
        let mut best = usize::MAX;
        let mut e = i32::MAX;
        for i in 0..BN_CELLS {
            if !self.on[i] && self.energy[i] < e {
                e = self.energy[i];
                best = i;
            }
        }
        best
    }
}

/// Generate a 64x64 blue-noise rank map (a permutation of 0..4096) with
/// Ulichney's void-and-cluster method.
pub fn generate_blue_noise() -> Vec<u16> {
    let mut f = Field {
        on: vec![false; BN_CELLS],
        energy: vec![0; BN_CELLS],
    };

    // 1. Sparse random seed pattern (~10%).
    let initial = BN_CELLS / 10;
    let mut placed = 0;
    let mut k = 0u32;
    while placed < initial {
        let i = (hash3(k, 0x5eed, BN_MAP_SEED) as usize) & (BN_CELLS - 1);
        k += 1;
        if !f.on[i] {
            f.toggle(i, true);
            placed += 1;
        }
    }

    // 2. Relax it: move the tightest cluster into the largest void until stable.
    for _ in 0..(4 * BN_CELLS) {
        let c = f.tightest();
        f.toggle(c, false);
        let v = f.largest_void();
        if v == c {
            f.toggle(c, true);
            break;
        }
        f.toggle(v, true);
    }

    let proto_on = f.on.clone();
    let proto_energy = f.energy.clone();
    let mut rank = vec![0u16; BN_CELLS];

    // 3. Phase 1: peel off clusters, highest rank first.
    let mut r = initial;
    while r > 0 {
        r -= 1;
        let c = f.tightest();
        f.toggle(c, false);
        rank[c] = r as u16;
    }

    // 4. Phases 2 and 3: fill voids from the prototype upwards.
    f.on = proto_on;
    f.energy = proto_energy;
    for r in initial..BN_CELLS {
        let v = f.largest_void();
        f.toggle(v, true);
        rank[v] = r as u16;
    }
    rank
}

/// The shared threshold map, generated once per process.
pub fn blue_noise_map() -> &'static [u16] {
    static MAP: OnceLock<Vec<u16>> = OnceLock::new();
    MAP.get_or_init(generate_blue_noise)
}

/// Ordered dither against the blue-noise map. `(ox, oy)` shifts the tile so
/// the two plates do not share the same dot pattern.
pub fn blue_noise(buf: &[i32], w: usize, h: usize, ox: usize, oy: usize) -> Vec<u8> {
    let map = blue_noise_map();
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        let row = ((y + oy) & (BN_SIZE - 1)) * BN_SIZE;
        for x in 0..w {
            let r = map[row + ((x + ox) & (BN_SIZE - 1))] as i32;
            // ink when coverage/255 > (rank + 0.5)/4096
            out[y * w + x] = (buf[y * w + x] * 8192 > (2 * r + 1) * 255) as u8;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fs_known_answer_1d_row() {
        // 4x1 row of 100: errors can only travel right (7/16).
        // 100 -> 0 (e7=43), 143 -> ink (e7=-49), 51 -> 0 (e7=22), 122 -> 0
        let mut buf = vec![100; 4];
        assert_eq!(floyd_steinberg(&mut buf, 4, 1), vec![0, 1, 0, 0]);
    }

    #[test]
    fn fs_known_answer_2x2_mid_grey() {
        // Hand-worked: 128 -> ink (err -127: e7 -56, e3 -24, e5 -40, e1 -7);
        // (1,0) 72 -> paper; row 1 runs right-to-left: (1,1) 143 -> ink;
        // (0,1) 52 -> paper. A perfect checkerboard.
        let mut buf = vec![128; 4];
        assert_eq!(floyd_steinberg(&mut buf, 2, 2), vec![1, 0, 0, 1]);
    }

    #[test]
    fn fs_4x4_quarter_grey_known_answer() {
        // Cross-checked with an independent scalar model of the same rules.
        // Only 3 of 16 dots ink (not 4): error pushed off the right and
        // bottom edges is lost, as in every bounded FS implementation.
        let mut buf = vec![64; 16];
        let out = floyd_steinberg(&mut buf, 4, 4);
        assert_eq!(out, vec![0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
    }

    #[test]
    fn atkinson_known_answer_2x2_mid_grey() {
        // 128 -> ink, err -127 >> 3 = -16 to (1,0), (0,1), (1,1).
        // (1,0) = 112 -> paper, err 112 >> 3 = 14 to (0,1), (1,1).
        // (0,1) = 126 -> paper, err 15 to (1,1). (1,1) = 141 -> ink.
        let mut buf = vec![128; 4];
        assert_eq!(atkinson(&mut buf, 2, 2), vec![1, 0, 0, 1]);
    }

    #[test]
    fn atkinson_4x4_known_answer() {
        // Cross-checked with an independent scalar model. Atkinson drops 2/8
        // of every error, so a 78% tint prints almost solid on a tiny tile.
        let mut buf = vec![200; 16];
        let out = atkinson(&mut buf, 4, 4);
        assert_eq!(out, vec![1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]);
    }

    #[test]
    fn solids_stay_solid() {
        for v in [0, 255] {
            let expect = if v == 255 { 1 } else { 0 };
            let mut a = vec![v; 64];
            let mut b = vec![v; 64];
            assert!(floyd_steinberg(&mut a, 8, 8).iter().all(|&o| o == expect));
            assert!(atkinson(&mut b, 8, 8).iter().all(|&o| o == expect));
            assert!(blue_noise(&vec![v; 64], 8, 8, 3, 5)
                .iter()
                .all(|&o| o == expect));
        }
    }

    #[test]
    fn blue_noise_map_is_a_permutation() {
        let map = blue_noise_map();
        let mut seen = vec![false; BN_CELLS];
        for &r in map {
            assert!(!seen[r as usize], "rank {r} repeated");
            seen[r as usize] = true;
        }
        assert!(seen.iter().all(|&s| s));
    }

    #[test]
    fn blue_noise_mid_grey_known_count() {
        // ink iff 128*8192 > (2r+1)*255  <=>  r <= 2055  -> exactly 2056 cells.
        let out = blue_noise(&vec![128; BN_CELLS], BN_SIZE, BN_SIZE, 0, 0);
        assert_eq!(out.iter().filter(|&&v| v == 1).count(), 2056);
    }

    #[test]
    fn blue_noise_sparse_points_are_well_spread() {
        // The first 256 ranks (1 in 16 cells) should sit far apart. White
        // noise at this density would have ~95 pairs within distance 2.
        let map = blue_noise_map();
        let pts: Vec<(i32, i32)> = (0..BN_CELLS)
            .filter(|&i| map[i] < 256)
            .map(|i| ((i % BN_SIZE) as i32, (i / BN_SIZE) as i32))
            .collect();
        assert_eq!(pts.len(), 256);
        let n = BN_SIZE as i32;
        let mut min_d2 = i32::MAX;
        for (i, p) in pts.iter().enumerate() {
            for q in &pts[i + 1..] {
                let dx = (p.0 - q.0).abs().min(n - (p.0 - q.0).abs());
                let dy = (p.1 - q.1).abs().min(n - (p.1 - q.1).abs());
                min_d2 = min_d2.min(dx * dx + dy * dy);
            }
        }
        assert!(min_d2 >= 5, "closest pair distance^2 = {min_d2}");
    }

    #[test]
    fn kernel_matches_its_formula() {
        for (d2, &k) in KERNEL.iter().enumerate() {
            let exact = (65536.0 * (-(d2 as f64) / 4.5).exp()).round() as i32;
            assert_eq!(k, exact, "d2 = {d2}");
        }
    }
}
