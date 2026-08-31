//! Asymmetric distance: full-precision f32 query × int8-stored vector, matching the JS
//! implementation (quantizeInt8 scale + cached 1/|v|). Written as autovectorizable loops;
//! explicit AVX2/NEON intrinsics are a measured follow-up if codegen disappoints.

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

/// Cosine distance against an int8-quantized stored vector.
/// stored dot = scale * Σ q[i] * v[i]; distance = 1 - dot * inv_mag_stored * inv_mag_query.
#[inline]
pub fn cosine_int8(query: &Query, stored: &[i8], scale: f32, stored_inv_mag: f32) -> f32 {
    debug_assert_eq!(query.vector.len(), stored.len());
    let mut acc = [0.0f32; 8];
    let chunks = stored.len() / 8;
    for c in 0..chunks {
        let base = c * 8;
        for lane in 0..8 {
            acc[lane] += query.vector[base + lane] * stored[base + lane] as f32;
        }
    }
    let mut dot: f32 = acc.iter().sum();
    for i in chunks * 8..stored.len() {
        dot += query.vector[i] * stored[i] as f32;
    }
    1.0 - dot * scale * stored_inv_mag * query.inv_mag
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
