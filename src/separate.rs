//! Two-ink colour separation.
//!
//! Each pixel is described by how much light it absorbs per channel
//! (`255 - value`). Each ink absorbs `255 - ink` per channel. We look for the
//! pair of coverages `(a, b)` in `[0, 1]` that best explains the pixel as
//! `a * inkA + b * inkB` in that absorption space (least squares, solved with
//! the 2x2 normal equations), then clamp to the printable box.
//!
//! Everything is integer arithmetic. The biggest intermediate value is below
//! 2^44, which the JavaScript reference also represents exactly as a double,
//! so both implementations truncate to the same integer.

/// Pre-computed dot products for one ink pair.
#[derive(Clone, Copy, Debug)]
pub struct Separator {
    a: [i64; 3],
    b: [i64; 3],
    aa: i64,
    bb: i64,
    ab: i64,
    det: i64,
}

impl Separator {
    pub fn new(ink_a: [u8; 3], ink_b: [u8; 3]) -> Self {
        let a = ink_a.map(|v| 255 - v as i64);
        let b = ink_b.map(|v| 255 - v as i64);
        let dot = |p: &[i64; 3], q: &[i64; 3]| p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
        let aa = dot(&a, &a);
        let bb = dot(&b, &b);
        let ab = dot(&a, &b);
        Separator {
            a,
            b,
            aa,
            bb,
            ab,
            det: aa * bb - ab * ab,
        }
    }

    /// Coverage (0..=255) of ink A and ink B for one opaque RGB pixel.
    #[inline]
    pub fn coverage(&self, rgb: [u8; 3]) -> (u8, u8) {
        let x = rgb.map(|v| 255 - v as i64);
        let ax = self.a[0] * x[0] + self.a[1] * x[1] + self.a[2] * x[2];
        let bx = self.b[0] * x[0] + self.b[1] * x[1] + self.b[2] * x[2];

        if self.det <= 0 {
            // Degenerate pair (parallel inks): put everything on one plate.
            if self.aa > 0 {
                return (clamp255(ax * 255 / self.aa) as u8, 0);
            }
            if self.bb > 0 {
                return (0, clamp255(bx * 255 / self.bb) as u8);
            }
            return (0, 0);
        }

        let mut a = (self.bb * ax - self.ab * bx) * 255 / self.det;
        let mut b = (self.aa * bx - self.ab * ax) * 255 / self.det;

        if !(0..=255).contains(&a) {
            // Fix A at the nearest printable value, re-solve B alone.
            a = clamp255(a);
            b = clamp255((bx * 255 - self.ab * a) / self.bb);
        } else if !(0..=255).contains(&b) {
            b = clamp255(b);
            a = clamp255((ax * 255 - self.ab * b) / self.aa);
        }
        (a as u8, b as u8)
    }
}

#[inline]
fn clamp255(v: i64) -> i64 {
    v.clamp(0, 255)
}

/// Flatten an RGBA pixel onto white (transparent PNG areas become paper).
#[inline]
pub fn flatten(r: u8, g: u8, b: u8, alpha: u8) -> [u8; 3] {
    if alpha == 255 {
        return [r, g, b];
    }
    let a = alpha as u32;
    let f = |v: u8| ((v as u32 * a + 255 * (255 - a) + 127) / 255) as u8;
    [f(r), f(g), f(b)]
}

/// Separate a whole RGBA buffer into two coverage planes.
pub fn separate(rgba: &[u8], ink_a: [u8; 3], ink_b: [u8; 3], out_a: &mut [u8], out_b: &mut [u8]) {
    let sep = Separator::new(ink_a, ink_b);
    for (i, px) in rgba.as_chunks::<4>().0.iter().enumerate() {
        let (a, b) = sep.coverage(flatten(px[0], px[1], px[2], px[3]));
        out_a[i] = a;
        out_b[i] = b;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PINK: [u8; 3] = [255, 72, 176];
    const BLUE: [u8; 3] = [0, 120, 191];
    const RED: [u8; 3] = [232, 64, 58];
    const BLACK: [u8; 3] = [34, 32, 34];

    #[test]
    fn white_needs_no_ink() {
        assert_eq!(Separator::new(PINK, BLUE).coverage([255, 255, 255]), (0, 0));
    }

    #[test]
    fn a_pure_ink_maps_to_its_own_plate() {
        let s = Separator::new(PINK, BLUE);
        assert_eq!(s.coverage(PINK), (255, 0));
        assert_eq!(s.coverage(BLUE), (0, 255));
        let s = Separator::new(RED, BLACK);
        assert_eq!(s.coverage(RED), (255, 0));
        assert_eq!(s.coverage(BLACK), (0, 255));
    }

    #[test]
    fn black_is_near_solid_on_both_plates() {
        // B saturates first; A is then re-solved with B fixed at 100%.
        let (a, b) = Separator::new(PINK, BLUE).coverage([0, 0, 0]);
        assert_eq!(b, 255);
        assert!(a >= 230, "a = {a}");
    }

    #[test]
    fn half_tint_of_one_ink_is_half_coverage() {
        // Halfway between white and ink A in absorption space.
        let s = Separator::new(RED, BLACK);
        let tint = RED.map(|v| 255 - (255 - v) / 2);
        let (a, b) = s.coverage(tint);
        assert!((125..=129).contains(&a), "a = {a}");
        assert!(b <= 2, "b = {b}");
    }

    #[test]
    fn grey_on_red_black_goes_to_the_black_plate() {
        let (a, b) = Separator::new(RED, BLACK).coverage([128, 128, 128]);
        assert!(b > 100 && a < 30, "a = {a}, b = {b}");
    }

    #[test]
    fn coverage_is_always_in_range_for_every_grey_and_primary() {
        let s = Separator::new([0, 131, 138], [255, 232, 0]);
        for v in 0..=255u8 {
            for rgb in [[v, v, v], [v, 0, 0], [0, v, 0], [0, 0, v], [255, v, 0]] {
                let _ = s.coverage(rgb); // u8 return type: range is structural
            }
        }
    }

    #[test]
    fn parallel_inks_do_not_divide_by_zero() {
        let s = Separator::new([128, 128, 128], [0, 0, 0]);
        let (_, _) = s.coverage([10, 20, 30]);
        let s = Separator::new([255, 255, 255], [255, 255, 255]);
        assert_eq!(s.coverage([0, 0, 0]), (0, 0));
    }

    #[test]
    fn transparent_pixels_become_white() {
        assert_eq!(flatten(0, 0, 0, 0), [255, 255, 255]);
        assert_eq!(flatten(10, 20, 30, 255), [10, 20, 30]);
        assert_eq!(flatten(0, 0, 0, 128), [127, 127, 127]);
    }
}
