//! Whole-pipeline checks: seeded determinism and a pinned golden fingerprint.
//!
//! The same fingerprints are asserted in `tests/equality.test.mjs` against the
//! WebAssembly build and the plain-JavaScript reference, so native Rust,
//! wasm32 and JS are all held to one answer.

use overprint::{render_rgba, Params};

/// Deterministic synthetic test card (also rebuilt in the JS tests).
pub fn test_card(w: usize, h: usize) -> Vec<u8> {
    let mut v = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            v.push(((x * 37 + y * 11) & 255) as u8);
            v.push(((x * 5 + y * 23 + 64) & 255) as u8);
            v.push((((x ^ y) * 13) & 255) as u8);
            v.push(if (x + y) % 7 == 0 { 128 } else { 255 });
        }
    }
    v
}

fn fnv1a(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

fn params(
    ink_a: [i32; 3],
    ink_b: [i32; 3],
    dither: i32,
    reg: (i32, i32),
    grain: i32,
    seed: i32,
    view: i32,
) -> Params {
    let raw = [
        ink_a[0], ink_a[1], ink_a[2], ink_b[0], ink_b[1], ink_b[2], 244, 240, 230, dither, reg.0,
        reg.1, grain, 100, 100, seed, view,
    ];
    Params::from_slice(&raw).unwrap()
}

const PINK: [i32; 3] = [255, 72, 176];
const BLUE: [i32; 3] = [0, 120, 191];

#[test]
fn same_job_same_bytes() {
    let img = test_card(97, 61);
    for dither in 0..3 {
        let p = params(PINK, BLUE, dither, (3, -2), 55, 1234, 0);
        let a = render_rgba(&img, 97, 61, &p).unwrap();
        let b = render_rgba(&img, 97, 61, &p).unwrap();
        assert_eq!(a, b, "dither {dither}");
        assert_eq!(a.len(), 97 * 61 * 4);
    }
}

#[test]
fn seed_changes_grain_and_blue_noise_only_when_used() {
    let img = test_card(64, 64);
    let r = |dither, grain, seed| {
        render_rgba(
            &img,
            64,
            64,
            &params(PINK, BLUE, dither, (0, 0), grain, seed, 0),
        )
        .unwrap()
    };
    // Grain off + error diffusion: the seed has nothing to act on.
    assert_eq!(r(0, 0, 1), r(0, 0, 2));
    // Grain on: different seed, different print.
    assert_ne!(r(0, 50, 1), r(0, 50, 2));
    // Blue noise uses the seed to offset each plate's threshold tile.
    assert_ne!(r(2, 0, 1), r(2, 0, 2));
}

#[test]
fn output_only_contains_the_four_palette_colours() {
    let img = test_card(50, 40);
    let out = render_rgba(&img, 50, 40, &params(PINK, BLUE, 1, (2, 2), 30, 9, 0)).unwrap();
    let pal = overprint::compose::palette([244, 240, 230], [255, 72, 176], [0, 120, 191]);
    for px in out.as_chunks::<4>().0 {
        assert!(
            pal.iter().any(|c| c[..] == px[..3]),
            "unexpected colour {px:?}"
        );
        assert_eq!(px[3], 255);
    }
}

/// Golden fingerprints. If an algorithm changes on purpose, update these
/// here AND in tests/equality.test.mjs.
#[test]
fn golden_fingerprints() {
    let img = test_card(120, 80);
    let cases = [
        (params(PINK, BLUE, 0, (0, 0), 0, 7, 0), GOLDEN[0]),
        (params(PINK, BLUE, 1, (2, -1), 40, 7, 0), GOLDEN[1]),
        (
            params([0, 131, 138], [255, 232, 0], 2, (-3, 4), 80, 99, 0),
            GOLDEN[2],
        ),
        (
            params([232, 64, 58], [34, 32, 34], 0, (5, 5), 100, 3, 2),
            GOLDEN[3],
        ),
    ];
    let got: Vec<u32> = cases
        .iter()
        .map(|(p, _)| fnv1a(&render_rgba(&img, 120, 80, p).unwrap()))
        .collect();
    let want: Vec<u32> = cases.iter().map(|(_, g)| *g).collect();
    assert_eq!(got, want, "got {got:#010x?}");
}

const GOLDEN: [u32; 4] = [0x4ab4_027d, 0x93bf_8739, 0xaacf_dabd, 0x4dd8_ec25];
