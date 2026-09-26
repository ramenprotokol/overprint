//! Put the two plates on paper.
//!
//! Plate A is the key plate and never moves. Plate B is shifted by the
//! mis-registration offset (clamped to +-MAX_REG dots); anything shifted in
//! from outside the sheet is bare paper, like a real mis-fed sheet.
//!
//! Inks are transparent and multiply: where both print, the colour is
//! `paper * (inkA / paper) * (inkB / paper)` per channel.

pub const MAX_REG: i32 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Composite,
    PlateA,
    PlateB,
}

/// The four colours a dot can end up as: paper, A, B, A over B.
pub fn palette(paper: [u8; 3], ink_a: [u8; 3], ink_b: [u8; 3]) -> [[u8; 3]; 4] {
    let mut ab = [0u8; 3];
    for c in 0..3 {
        let p = paper[c] as u32;
        ab[c] = (ink_a[c] as u32 * ink_b[c] as u32 + p / 2)
            .checked_div(p)
            .map_or(0, |v| v.min(255) as u8);
    }
    [paper, ink_a, ink_b, ab]
}

pub fn clamp_reg(v: i32) -> i32 {
    v.clamp(-MAX_REG, MAX_REG)
}

#[allow(clippy::too_many_arguments)]
pub fn compose(
    plate_a: &[u8],
    plate_b: &[u8],
    w: usize,
    h: usize,
    reg_x: i32,
    reg_y: i32,
    view: View,
    colors: [[u8; 3]; 4],
) -> Vec<u8> {
    let (dx, dy) = (clamp_reg(reg_x) as isize, clamp_reg(reg_y) as isize);
    let show_a = view != View::PlateB;
    let show_b = view != View::PlateA;
    let mut out = vec![0u8; w * h * 4];
    for y in 0..h {
        let sy = y as isize - dy;
        for x in 0..w {
            let i = y * w + x;
            let a = show_a && plate_a[i] != 0;
            let sx = x as isize - dx;
            let b = show_b
                && sx >= 0
                && sy >= 0
                && (sx as usize) < w
                && (sy as usize) < h
                && plate_b[sy as usize * w + sx as usize] != 0;
            let c = colors[(a as usize) | ((b as usize) << 1)];
            let o = i * 4;
            out[o] = c[0];
            out[o + 1] = c[1];
            out[o + 2] = c[2];
            out[o + 3] = 255;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAPER: [u8; 3] = [244, 240, 230];
    const A: [u8; 3] = [255, 72, 176];
    const B: [u8; 3] = [0, 120, 191];

    fn px(out: &[u8], w: usize, x: usize, y: usize) -> [u8; 3] {
        let o = (y * w + x) * 4;
        [out[o], out[o + 1], out[o + 2]]
    }

    #[test]
    fn overprint_multiplies() {
        let p = palette(PAPER, A, B);
        // 255*0/244 = 0 ; 72*120/240 = 36 ; 176*191/230 = 146.2 -> 146
        assert_eq!(p[3], [0, 36, 146]);
        // Overprint is never lighter than either ink on a paper-white channel.
        let p = palette([255, 255, 255], [200, 100, 50], [100, 200, 50]);
        assert_eq!(p[3], [78, 78, 10]);
    }

    #[test]
    fn registration_shifts_plate_b_only() {
        let (w, h) = (5, 4);
        let mut a = vec![0u8; w * h];
        let mut b = vec![0u8; w * h];
        a[w + 1] = 1; // A at (1,1)
        b[w + 1] = 1; // B at (1,1)
        let colors = palette(PAPER, A, B);
        let out = compose(&a, &b, w, h, 2, 1, View::Composite, colors);
        assert_eq!(px(&out, w, 1, 1), A); // A stays
        assert_eq!(px(&out, w, 3, 2), B); // B moved by (+2,+1)
        let aligned = compose(&a, &b, w, h, 0, 0, View::Composite, colors);
        assert_eq!(px(&aligned, w, 1, 1), colors[3]);
    }

    #[test]
    fn registration_is_clamped_and_never_reads_out_of_bounds() {
        let (w, h) = (3, 3);
        let a = vec![0u8; 9];
        let b = vec![1u8; 9];
        let colors = palette(PAPER, A, B);
        for (dx, dy) in [
            (1000, 0),
            (-1000, 7),
            (0, i32::MIN),
            (i32::MAX, i32::MAX),
            (16, -16),
        ] {
            let out = compose(&a, &b, w, h, dx, dy, View::Composite, colors);
            assert_eq!(out.len(), w * h * 4);
            // Every offset here is at least 3 dots: plate B leaves the 3x3 sheet.
            assert!(
                out.as_chunks::<4>().0.iter().all(|p| p[..3] == PAPER),
                "offset {dx},{dy}"
            );
        }
        assert_eq!(clamp_reg(1000), MAX_REG);
        assert_eq!(clamp_reg(-1000), -MAX_REG);
        assert_eq!(clamp_reg(5), 5);
    }

    #[test]
    fn proof_views_hide_the_other_plate() {
        let a = vec![1u8; 4];
        let b = vec![1u8; 4];
        let colors = palette(PAPER, A, B);
        let only_a = compose(&a, &b, 2, 2, 0, 0, View::PlateA, colors);
        let only_b = compose(&a, &b, 2, 2, 0, 0, View::PlateB, colors);
        assert!(only_a.as_chunks::<4>().0.iter().all(|p| p[..3] == A));
        assert!(only_b.as_chunks::<4>().0.iter().all(|p| p[..3] == B));
    }
}
