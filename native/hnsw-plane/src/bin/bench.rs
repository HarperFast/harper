//! Standalone cost benchmark: build an N-node graph in the plane file, run queries, report
//! per-visit cost — the number that decides whether the native plane hits its 0.25–0.4 µs
//! budget (JS baseline: 4.34 µs/visit at 5M/ef 512).
//!
//! Usage: bench [n=100000] [dims=768] [queries=200] [ef=512] [path=/tmp/bench.hnsw]

use hnsw_plane::distance::Query;
use hnsw_plane::insert::{insert, InsertParams};
use hnsw_plane::search::{search, SearchScratch};
use hnsw_plane::{Graph, PlaneFile};
use std::path::PathBuf;
use std::time::Instant;

// xorshift for reproducible synthetic vectors without a rand dependency
struct Rng(u64);
impl Rng {
    fn next_f32(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32 - 0.5
    }
    fn vector(&mut self, dims: usize) -> Vec<f32> {
        (0..dims).map(|_| self.next_f32()).collect()
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: u64 = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(100_000);
    let dims: usize = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(768);
    let queries: usize = args.get(3).and_then(|a| a.parse().ok()).unwrap_or(200);
    let ef: usize = args.get(4).and_then(|a| a.parse().ok()).unwrap_or(512);
    let path: PathBuf = args.get(5).map(Into::into).unwrap_or_else(|| "/tmp/bench.hnsw".into());

    let layer0_cap = 64;
    let file = PlaneFile::create(&path, dims, layer0_cap, n + 1024).expect("create");
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

    let build_start = Instant::now();
    for i in 0..n {
        let v = rng.vector(dims);
        insert(&graph, &v, &params, &mut scratch);
        if (i + 1) % 50_000 == 0 {
            let rate = (i + 1) as f64 / build_start.elapsed().as_secs_f64();
            println!("  built {} ({:.0} inserts/s)", i + 1, rate);
        }
    }
    let build = build_start.elapsed();
    println!("build: {:.1}s ({:.0} inserts/s)", build.as_secs_f64(), n as f64 / build.as_secs_f64());

    // Query with held-out vectors.
    let mut latencies = Vec::with_capacity(queries);
    let mut total_visits = 0u64;
    for _ in 0..queries {
        let q = Query::new(rng.vector(dims));
        let start = Instant::now();
        let (results, stats) = search(&graph, &q, 10, ef, &mut scratch);
        latencies.push(start.elapsed());
        total_visits += stats.visits;
        assert!(!results.is_empty());
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
}
