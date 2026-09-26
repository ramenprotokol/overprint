//! Seeded ink grain.
//!
//! Real stencil-printed ink is uneven: solids are mottled and a little
//! starved in places. We model that by nudging each plate's coverage before
//! dithering, with two layers of seeded noise:
//! * fine: per-pixel hash noise (range -64..=63 after halving),
//! * coarse: value noise on a 16-pixel lattice, bilinearly blended (-128..=127).
//!
//! The nudge is proportional to the coverage itself, so bare paper stays
//! bare and only inked areas get texture.

use crate::hash::hash3;

pub const MAX_GRAIN: i32 = 100;
const CELL_SHIFT: u32 = 4; // 16-pixel lattice
const CELL: i32 = 1 << CELL_SHIFT;

#[inline]
fn lattice(i: u32, j: u32, salt: u32) -> i32 {
    (hash3(i, j, salt) & 255) as i32 - 128
}

/// Coarse value noise in -128..=127.
#[inline]
pub fn coarse(x: u32, y: u32, salt: u32) -> i32 {
    let (i, j) = (x >> CELL_SHIFT, y >> CELL_SHIFT);
    let fx = (x & (CELL as u32 - 1)) as i32;
    let fy = (y & (CELL as u32 - 1)) as i32;
    let top = lattice(i, j, salt) * (CELL - fx) + lattice(i + 1, j, salt) * fx;
    let bot = lattice(i, j + 1, salt) * (CELL - fx) + lattice(i + 1, j + 1, salt) * fx;
    (top * (CELL - fy) + bot * fy) >> (2 * CELL_SHIFT)
}

/// Fine per-pixel noise in -128..=127.
#[inline]
pub fn fine(x: u32, y: u32, salt: u32) -> i32 {
    (hash3(x, y, salt) & 255) as i32 - 128
}

/// Apply density (percent, 0..=200) and grain (0..=100) to one coverage
/// plane, producing the signed working buffer the ditherers consume.
pub fn prepare_plate(cov: &[u8], w: usize, density: i32, grain: i32, salt: u32) -> Vec<i32> {
    let coarse_salt = salt ^ 0x68bc_21eb;
    let mut out = Vec::with_capacity(cov.len());
    for (i, &c) in cov.iter().enumerate() {
        let mut v = (c as i32 * density / 100).min(255);
        if grain > 0 && v > 0 {
            let (x, y) = ((i % w) as u32, (i / w) as u32);
            let n = (fine(x, y, salt) >> 1) + coarse(x, y, coarse_salt);
            v = (v + n * grain * v / 51_200).clamp(0, 255);
        }
        out.push(v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_ranges() {
        for y in 0..64 {
            for x in 0..64 {
                assert!((-128..=127).contains(&coarse(x, y, 7)));
                assert!((-128..=127).contains(&fine(x, y, 7)));
            }
        }
    }

    #[test]
    fn coarse_noise_is_continuous_inside_a_cell() {
        for x in 0..15 {
            let d = (coarse(x + 1, 3, 11) - coarse(x, 3, 11)).abs();
            assert!(d <= 16, "jump {d} at x={x}");
        }
    }

    #[test]
    fn zero_grain_only_applies_density() {
        let cov = [0u8, 100, 200, 255];
        assert_eq!(prepare_plate(&cov, 4, 100, 0, 1), vec![0, 100, 200, 255]);
        assert_eq!(prepare_plate(&cov, 4, 50, 0, 1), vec![0, 50, 100, 127]);
        assert_eq!(prepare_plate(&cov, 4, 200, 0, 1), vec![0, 200, 255, 255]);
    }

    #[test]
    fn grain_never_inks_bare_paper_and_stays_in_range() {
        let cov: Vec<u8> = (0..4096).map(|i| (i % 256) as u8).collect();
        let out = prepare_plate(&cov, 64, 100, MAX_GRAIN, 42);
        for (c, v) in cov.iter().zip(&out) {
            assert!((0..=255).contains(v));
            if *c == 0 {
                assert_eq!(*v, 0);
            }
        }
        assert_ne!(out, prepare_plate(&cov, 64, 100, 0, 42));
    }

    #[test]
    fn grain_is_seeded() {
        let cov = vec![180u8; 1024];
        let a = prepare_plate(&cov, 32, 100, 60, 1);
        assert_eq!(a, prepare_plate(&cov, 32, 100, 60, 1));
        assert_ne!(a, prepare_plate(&cov, 32, 100, 60, 2));
    }
}
