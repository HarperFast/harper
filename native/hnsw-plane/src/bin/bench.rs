//! Standalone cost benchmark: build an N-node graph in the plane file, run queries, report
//! per-visit cost — the number that decides whether the native plane hits its 0.25–0.4 µs
//! budget (JS baseline: 4.34 µs/visit at 5M/ef 512).
//!
//! Usage: bench [n=100000] [dims=768] [queries=200] [ef=512] [path=/tmp/bench.hnsw] [cap=128]

use hnsw_plane::distance::Query;
use hnsw_plane::insert::{insert, InsertParams};
use hnsw_plane::search::{search, SearchScratch};
use hnsw_plane::{Graph, PlaneFile};
use std::path::PathBuf;
use std::time::Instant;

// xorshift for reproducible synthetic vectors without a rand dependency
struct Rng(u64);
impl Rng {
    fn next_unit(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
    // Box-Muller
    fn next_gauss(&mut self) -> f32 {
        let u1 = self.next_unit().max(f32::MIN_POSITIVE);
        let u2 = self.next_unit();
        (-2.0 * u1.ln()).sqrt() * (2.0 * std::f32::consts::PI * u2).cos()
    }
}

/// Gaussian-mixture corpus matching benchmarks/hnsw-scale.js: unit centroids, per-dim noise
/// derived from an intra-cluster cosine target of 0.75 (uniform-random 768-d is a corpus
/// "no ANN can index" per that benchmark's own calibration notes).
struct Corpus {
    centroids: Vec<f32>,
    n_clusters: usize,
    dims: usize,
    noise: f32,
}

impl Corpus {
    fn new(n: u64, dims: usize, rng: &mut Rng) -> Self {
        let intra_cos = 0.75f32;
        let noise = ((1.0 / (intra_cos * intra_cos) - 1.0) / dims as f32).sqrt();
        let n_clusters = 8.max((n as f64 / 500.0).round() as usize);
        let mut centroids = vec![0.0f32; n_clusters * dims];
        for c in 0..n_clusters {
            let mut mag = 0.0f32;
            for d in 0..dims {
                let x = rng.next_gauss();
                centroids[c * dims + d] = x;
                mag += x * x;
            }
            let mag = mag.sqrt().max(f32::MIN_POSITIVE);
            for d in 0..dims {
                centroids[c * dims + d] /= mag;
            }
        }
        Corpus { centroids, n_clusters, dims, noise }
    }

    fn row(&self, rng: &mut Rng) -> Vec<f32> {
        let c = (rng.next_unit() * self.n_clusters as f32) as usize % self.n_clusters;
        let mut v = vec![0.0f32; self.dims];
        let mut mag = 0.0f32;
        for d in 0..self.dims {
            let x = self.centroids[c * self.dims + d] + rng.next_gauss() * self.noise;
            v[d] = x;
            mag += x * x;
        }
        let mag = mag.sqrt().max(f32::MIN_POSITIVE);
        for d in 0..self.dims {
            v[d] /= mag;
        }
        v
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: u64 = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(100_000);
    let dims: usize = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(768);
    let queries: usize = args.get(3).and_then(|a| a.parse().ok()).unwrap_or(200);
    let ef: usize = args.get(4).and_then(|a| a.parse().ok()).unwrap_or(512);
    let path: PathBuf = args.get(5).map(Into::into).unwrap_or_else(|| "/tmp/bench.hnsw".into());
    let layer0_cap: usize = args.get(6).and_then(|a| a.parse().ok()).unwrap_or(128);

    // Reuse an existing plane file when it already holds exactly n nodes at the same cap
    // (ef sweeps without rebuilding). The corpus RNG below replays identically.
    let reuse = PlaneFile::open(&path)
        .ok()
        .filter(|f| f.id_high_water() == n && f.layer0_cap == layer0_cap)
        .is_some();
    let file = if reuse {
        println!("reusing existing plane at {}", path.display());
        PlaneFile::open(&path).expect("open")
    } else {
        PlaneFile::create(&path, dims, layer0_cap, n + 1024).expect("create")
    };
    println!(
        "plane: {} nodes x {} dims, slot {} B, file {:.1} GB (sparse)",
        n,
        dims,
        file.slot_size,
        (n * file.slot_size as u64) as f64 / 1e9
    );
    let graph = Graph::new(file);
    let params = InsertParams::default();
    let mut scratch = SearchScratch::new();
    let mut rng = Rng(0x1234_5678_9abc_def0);
    let corpus = Corpus::new(n, dims, &mut rng);

    let upper_path = path.with_extension("hnsw.upper");
    if reuse {
        // replay the build's RNG draws so query rows match a fresh run, and load the
        // persisted upper-layer sidecar (missing sidecar = layer-0-only search).
        for _ in 0..n {
            let _ = corpus.row(&mut rng);
        }
        graph.load_upper(&upper_path).expect("load upper sidecar");
        let count = graph.upper.read().unwrap().len();
        println!("upper layers loaded: {} nodes with level > 0", count);
    } else {
        let build_start = Instant::now();
        for i in 0..n {
            let v = corpus.row(&mut rng);
            insert(&graph, &v, &params, &mut scratch);
            if (i + 1) % 50_000 == 0 {
                let rate = (i + 1) as f64 / build_start.elapsed().as_secs_f64();
                println!("  built {} ({:.0} inserts/s)", i + 1, rate);
            }
        }
        let build = build_start.elapsed();
        println!("build: {:.1}s ({:.0} inserts/s)", build.as_secs_f64(), n as f64 / build.as_secs_f64());
        graph.save_upper(&upper_path).expect("save upper sidecar");
    }

    // Query with held-out vectors; measure latency and set-recall@10 vs brute-force truth
    // (same asymmetric metric, so recall isolates graph quality, not quantization).
    let mut latencies = Vec::with_capacity(queries);
    let mut total_visits = 0u64;
    let mut recall_hits = 0usize;
    let mut recall_total = 0usize;
    for _ in 0..queries {
        let q = Query::new(corpus.row(&mut rng));
        let start = Instant::now();
        let (results, stats) = search(&graph, &q, 10, ef, &mut scratch);
        latencies.push(start.elapsed());
        total_visits += stats.visits;
        assert!(!results.is_empty());

        let mut truth: Vec<(u32, f32)> = (0..n as u32)
            .filter_map(|id| graph.distance_to(id, &q).map(|d| (id, d)))
            .collect();
        truth.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        truth.truncate(10);
        recall_total += truth.len();
        recall_hits += truth.iter().filter(|(tid, _)| results.iter().any(|(rid, _)| rid == tid)).count();
    }
    latencies.sort();
    let p50 = latencies[queries / 2];
    let p95 = latencies[queries * 95 / 100];
    let p99 = latencies[(queries * 99 / 100).min(queries - 1)];
    let mean_visits = total_visits as f64 / queries as f64;
    let us_per_visit = p50.as_micros() as f64 / mean_visits;
    println!(
        "search (ef {}): p50 {:.2} ms  p95 {:.2} ms  p99 {:.2} ms  visits/query {:.0}  ->  {:.3} us/visit (JS baseline 4.34)",
        ef,
        p50.as_secs_f64() * 1e3,
        p95.as_secs_f64() * 1e3,
        p99.as_secs_f64() * 1e3,
        mean_visits,
        us_per_visit
    );
    println!("recall@10 (set): {:.3}", recall_hits as f64 / recall_total as f64);
}
