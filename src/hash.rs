//! Integer hashing used for every "random" decision (grain, blue-noise tile
//! offsets, the blue-noise seed pattern).
//!
//! Only 32-bit wrapping multiplies, xors and logical shifts are used, so the
//! JavaScript reference (Math.imul / >>>) produces bit-identical values.

/// A small avalanche hash of three 32-bit words.
#[inline]
pub fn hash3(x: u32, y: u32, s: u32) -> u32 {
    let mut h =
        x.wrapping_mul(0x8da6_b343) ^ y.wrapping_mul(0xd816_3841) ^ s.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_values_are_stable() {
        // Pinned so any accidental change to the mixer is caught; the JS
        // reference asserts the same numbers.
        assert_eq!(hash3(0, 0, 0), 0);
        assert_eq!(hash3(1, 2, 3), 72_785_788);
        assert_eq!(hash3(0xdead_beef, 7, 0x9e37_79b9), 2_159_002_690);
        assert_eq!(hash3(8191, 8191, 417), 3_192_395_201);
        assert_ne!(hash3(1, 2, 3), hash3(2, 1, 3));
    }

    #[test]
    fn low_byte_is_roughly_uniform() {
        let mut buckets = [0u32; 4];
        for i in 0..40_000u32 {
            buckets[(hash3(i, i / 7, 99) & 3) as usize] += 1;
        }
        for b in buckets {
            assert!((9_000..11_000).contains(&b), "bucket {b}");
        }
    }
}
