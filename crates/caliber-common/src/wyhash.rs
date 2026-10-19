//! Bun-compatible hashing.
//!
//! `Bun.hash(string)` (as of Bun 1.x) is implemented with Zig's standard
//! library `std.hash.Wyhash` (a streaming adaptation of wyhash "final v4.1").
//! The value is **persisted data**: `lib-<hash36>` library ids are stored in
//! the user database progress rows and on-disk cache directory names. This
//! module reproduces Zig's one-shot `Wyhash.hash(seed, input)` exactly; the
//! unit tests pin it to vectors generated with Bun 1.4.2
//! (`bun -e 'console.log(Bun.hash(s))'`).

/// Secret from Zig `std.hash.Wyhash`.
const SECRET: [u64; 4] = [
    0xa0761d6478bd642f,
    0xe7037ed1a0b428db,
    0x8ebc6af09c88c6e3,
    0x589965cc75374cc3,
];

#[inline(always)]
fn wymum(a: &mut u64, b: &mut u64) {
    let r = (*a as u128) * (*b as u128);
    *a = r as u64;
    *b = (r >> 64) as u64;
}

#[inline(always)]
fn wymix(mut a: u64, mut b: u64) -> u64 {
    wymum(&mut a, &mut b);
    a ^ b
}

#[inline(always)]
fn read8(p: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(p[off..off + 8].try_into().unwrap())
}

#[inline(always)]
fn read4(p: &[u8], off: usize) -> u64 {
    u32::from_le_bytes(p[off..off + 4].try_into().unwrap()) as u64
}

/// Byte-for-byte equivalent of `Bun.hash(string)` / Zig `Wyhash.hash(0, s)`.
pub fn bun_hash(key: &[u8]) -> u64 {
    bun_hash_seeded(key, 0)
}

pub fn bun_hash_seeded(key: &[u8], seed: u64) -> u64 {
    let s0 = seed ^ wymix(seed ^ SECRET[0], SECRET[1]);
    let mut state = [s0, s0, s0];
    let len = key.len();
    let mut a;
    let mut b;

    if len <= 16 {
        // Zig smallKey
        if len >= 4 {
            let end = len - 4;
            let quarter = (len >> 3) << 2;
            a = (read4(key, 0) << 32) | read4(key, quarter);
            b = (read4(key, end) << 32) | read4(key, end - quarter);
        } else if len > 0 {
            a = ((key[0] as u64) << 16) | ((key[len >> 1] as u64) << 8) | key[len - 1] as u64;
            b = 0;
        } else {
            a = 0;
            b = 0;
        }
    } else {
        let mut i = 0usize;
        if len >= 48 {
            // Zig's loop is strictly `i + 48 < len`: an exactly-aligned
            // final 48-byte block is NOT consumed here (it flows into the
            // tail below via the last-16-bytes reads).
            while i + 48 < len {
                for j in 0..3 {
                    let x = read8(key, i + 16 * j) ^ SECRET[j + 1];
                    let y = read8(key, i + 16 * j + 8) ^ state[j];
                    state[j] = wymix(x, y);
                }
                i += 48;
            }
            state[0] ^= state[1] ^ state[2];
        }
        while i + 16 < len {
            state[0] = wymix(read8(key, i) ^ SECRET[1], read8(key, i + 8) ^ state[0]);
            i += 16;
        }
        a = read8(key, len - 16);
        b = read8(key, len - 8);
    }

    a ^= SECRET[1];
    b ^= state[0];
    wymum(&mut a, &mut b);
    wymix(a ^ SECRET[0] ^ (len as u64), b ^ SECRET[1])
}

/// JavaScript `Number.prototype.toString(36)`.
pub fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Canonical library identity: `CALIBRE_LIBRARY_ID` override or
/// `lib-<Bun.hash(path).toString(36)>`. Persisted in the user DB progress
/// rows (as `library_id`) and used to scope on-disk caches, so it must match
/// the TS implementation exactly.
pub fn canonical_library_id(library_path: &str, override_id: Option<&str>) -> String {
    if let Some(id) = override_id {
        let trimmed = id.trim();
        if !trimmed.is_empty() {
            return trimmed.chars().take(200).collect();
        }
    }
    format!("lib-{}", to_base36(bun_hash(library_path.as_bytes())))
}

/// Short library hash used for on-disk cache directory scoping
/// (`epub-cache/<libHash>-<bookId>`, `page-cache/...`).
pub fn library_hash36(library_path: &str) -> String {
    to_base36(bun_hash(library_path.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vectors generated with Bun 1.4.2: `bun -e 'console.log(Bun.hash(s))'`.
    const VECTORS: &[(&str, u64)] = &[
        ("", 290873116282709081),
        ("a", 2941419223392617777),
        ("ab", 13590985366118106092),
        ("abc", 190542993387777138),
        ("abcd", 5251164938674970899),
        ("abcde", 3875884390511759390),
        ("abcdef", 9754072584928271642),
        ("abcdefg", 12893279596959928940),
        ("abcdefgh", 3692222752269843843),
        ("abcdefghi", 10740737026755602898),
        ("1234567890123456", 1333946232150625147),
        ("12345678901234567", 18427539890266058574),
        (
            "123456789012345678901234567890123456789012345678",
            593262338653006634,
        ),
        (
            "1234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123",
            5615728855231292301,
        ),
        ("/Users/bsunter/Calibre Library", 2508790848314550981),
        ("/Volumes/Storage/Calibre Test Library", 8871461965642283027),
    ];

    #[test]
    fn bun_hash_matches_vectors() {
        for (input, expected) in VECTORS {
            let got = bun_hash(input.as_bytes());
            assert_eq!(&got, expected, "Bun.hash({input:?}) mismatch");
        }
    }

    #[test]
    fn base36_matches_vectors() {
        assert_eq!(to_base36(290873116282709081), "27k1wwwhf13t");
        assert_eq!(to_base36(2508790848314550981), "j26k4syibohx");
        assert_eq!(to_base36(8871461965642283027), "1vefyt06n9csz");
        assert_eq!(to_base36(0), "0");
    }

    #[test]
    fn library_id_matches_ts_shape() {
        assert_eq!(
            canonical_library_id("/Users/bsunter/Calibre Library", None),
            "lib-j26k4syibohx"
        );
        assert_eq!(canonical_library_id("/x", Some("custom-id")), "custom-id");
    }
}
