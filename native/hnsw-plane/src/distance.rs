//! Distance kernels. Asymmetric: full-precision f32 query × int8-stored vector (matches the JS
//! quantizeInt8 scale + cached 1/|v| model). Symmetric int8×int8 for construction-time
//! neighbor↔neighbor checks (stored per-edge distances were dropped from the format; recompute).
//! AVX2 with scalar fallback; Linux x86_64 is the performance target, other platforms take the
//! scalar path (fine for dev).

/// Precomputed query state, built once per search.
pub struct Query {
    pub vector: Vec<f32>,
    pub inv_mag: f32,
}

impl Query {
    pub fn new(vector: Vec<f32>) -> Self {
        let mag_sq: f32 = vector.iter().map(|v| v * v).sum();
        let inv_mag = 1.0 / mag_sq.sqrt().max(f32::MIN_POSITIVE);
        Query { vector, inv_mag }
    }
}

#[inline]
fn dot_f32_i8_scalar(q: &[f32], v: *const i8) -> f32 {
    let mut acc = [0.0f32; 8];
    let chunks = q.len() / 8;
    for c in 0..chunks {
        let base = c * 8;
        for lane in 0..8 {
            acc[lane] += q[base + lane] * unsafe { *v.add(base + lane) } as f32;
        }
    }
    let mut dot: f32 = acc.iter().sum();
    for i in chunks * 8..q.len() {
        dot += q[i] * unsafe { *v.add(i) } as f32;
    }
    dot
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2", enable = "fma")]
unsafe fn dot_f32_i8_avx2(q: &[f32], v: *const i8) -> f32 {
    use std::arch::x86_64::*;
    let mut acc0 = _mm256_setzero_ps();
    let mut acc1 = _mm256_setzero_ps();
    let chunks = q.len() / 16;
    for c in 0..chunks {
        let base = c * 16;
        let v16 = _mm_loadu_si128(v.add(base) as *const __m128i);
        let lo = _mm256_cvtepi32_ps(_mm256_cvtepi8_epi32(v16));
        let hi = _mm256_cvtepi32_ps(_mm256_cvtepi8_epi32(_mm_srli_si128(v16, 8)));
        acc0 = _mm256_fmadd_ps(_mm256_loadu_ps(q.as_ptr().add(base)), lo, acc0);
        acc1 = _mm256_fmadd_ps(_mm256_loadu_ps(q.as_ptr().add(base + 8)), hi, acc1);
    }
    let acc = _mm256_add_ps(acc0, acc1);
    let s = _mm_add_ps(_mm256_extractf128_ps(acc, 1), _mm256_castps256_ps128(acc));
    let s = _mm_hadd_ps(s, s);
    let s = _mm_hadd_ps(s, s);
    let mut dot = _mm_cvtss_f32(s);
    for i in chunks * 16..q.len() {
        dot += q[i] * *v.add(i) as f32;
    }
    dot
}

#[inline]
fn dot_f32_i8(q: &[f32], v: *const i8) -> f32 {
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("avx2") && std::arch::is_x86_feature_detected!("fma") {
            return unsafe { dot_f32_i8_avx2(q, v) };
        }
    }
    dot_f32_i8_scalar(q, v)
}

/// Cosine distance: f32 query × raw int8 vector at `stored` (dims = query.vector.len()).
/// Zero-copy: `stored` points into the mmap; the caller's seqlock read discards torn results.
#[inline]
pub fn cosine_int8_raw(query: &Query, stored: *const i8, scale: f32, stored_inv_mag: f32) -> f32 {
    let dot = dot_f32_i8(&query.vector, stored);
    1.0 - dot * scale * stored_inv_mag * query.inv_mag
}

#[inline]
fn dot_i8_i8_scalar(a: *const i8, b: *const i8, len: usize) -> i32 {
    let mut dot = 0i32;
    for i in 0..len {
        dot += unsafe { *a.add(i) as i32 * *b.add(i) as i32 };
    }
    dot
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn dot_i8_i8_avx2(a: *const i8, b: *const i8, len: usize) -> i32 {
    use std::arch::x86_64::*;
    let mut acc = _mm256_setzero_si256();
    let chunks = len / 16;
    for c in 0..chunks {
        let av = _mm256_cvtepi8_epi16(_mm_loadu_si128(a.add(c * 16) as *const __m128i));
        let bv = _mm256_cvtepi8_epi16(_mm_loadu_si128(b.add(c * 16) as *const __m128i));
        acc = _mm256_add_epi32(acc, _mm256_madd_epi16(av, bv));
    }
    let lo = _mm256_castsi256_si128(acc);
    let hi = _mm256_extracti128_si256(acc, 1);
    let s = _mm_add_epi32(lo, hi);
    let s = _mm_add_epi32(s, _mm_srli_si128(s, 8));
    let s = _mm_add_epi32(s, _mm_srli_si128(s, 4));
    let mut dot = _mm_cvtsi128_si32(s);
    for i in chunks * 16..len {
        dot += *a.add(i) as i32 * *b.add(i) as i32;
    }
    dot
}

/// Cosine distance between two int8-stored vectors (construction-time neighbor checks).
#[inline]
pub fn cosine_i8_i8_raw(a: *const i8, scale_a: f32, inv_mag_a: f32, b: *const i8, scale_b: f32, inv_mag_b: f32, len: usize) -> f32 {
    #[cfg(target_arch = "x86_64")]
    let dot = if std::arch::is_x86_feature_detected!("avx2") {
        unsafe { dot_i8_i8_avx2(a, b, len) }
    } else {
        dot_i8_i8_scalar(a, b, len)
    };
    #[cfg(not(target_arch = "x86_64"))]
    let dot = dot_i8_i8_scalar(a, b, len);
    1.0 - dot as f32 * scale_a * scale_b * inv_mag_a * inv_mag_b
}

/// Symmetric int8 quantization matching the JS quantizeInt8: scale maps max |component| to 127.
pub fn quantize_int8(vector: &[f32]) -> (Vec<i8>, f32, f32) {
    let max_abs = vector.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    let scale = if max_abs == 0.0 { 1.0 } else { max_abs / 127.0 };
    let inv_scale = 1.0 / scale;
    let bytes: Vec<i8> = vector.iter().map(|v| (v * inv_scale).round().clamp(-127.0, 127.0) as i8).collect();
    let mag_sq: f32 = vector.iter().map(|v| v * v).sum();
    let inv_mag = 1.0 / mag_sq.sqrt().max(f32::MIN_POSITIVE);
    (bytes, scale, inv_mag)
}
