//! hnsw-plane: native HNSW traversal plane over a memory-mapped fixed-slot file.
//! Design: ../../hnsw-native-plane.md. NAPI bindings land behind the `napi` feature in
//! phase-1 integration; the core is buildable and benchmarkable standalone.

pub mod distance;
pub mod format;
pub mod graph;
pub mod insert;
#[cfg(feature = "napi")]
mod napi;
pub mod search;
pub mod seqlock;

pub use format::PlaneFile;
pub use graph::Graph;
