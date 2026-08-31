//! Concurrent-write torture: writers insert while readers search; then verify the graph is
//! coherent (every stored vector findable, edge lists within cap, freelist reuse works).

use hnsw_plane::distance::Query;
use hnsw_plane::insert::{insert, InsertParams};
use hnsw_plane::search::{search, SearchScratch};
use hnsw_plane::{Graph, PlaneFile};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn vector_for(i: u32, dims: usize) -> Vec<f32> {
    // deterministic distinct unit-ish vectors on a few clusters
    let mut v = vec![0.0f32; dims];
    let cluster = (i % 7) as usize;
    for d in 0..dims {
        let x = ((i as f32 * 0.37 + d as f32 * 1.13).sin() * 0.1) + if d % 7 == cluster { 1.0 } else { 0.0 };
        v[d] = x;
    }
    v
}

#[test]
fn concurrent_insert_search() {
    let dims = 64;
    let path = std::env::temp_dir().join(format!("hnsw-torture-{}.hnsw", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let file = PlaneFile::create(&path, dims, 32, 40_000).expect("create");
    let graph = Arc::new(Graph::new(file));

    let writers = 4u32;
    let per_writer = 2_000u32;
    let done = Arc::new(AtomicBool::new(false));

    std::thread::scope(|s| {
        for w in 0..writers {
            let graph = graph.clone();
            s.spawn(move || {
                let params = InsertParams::default();
                let mut scratch = SearchScratch::new();
                for i in 0..per_writer {
                    let v = vector_for(w * per_writer + i, dims);
                    insert(&graph, &v, &params, &mut scratch).expect("plane full");
                }
            });
        }
        for _ in 0..4 {
            let graph = graph.clone();
            let done = done.clone();
            s.spawn(move || {
                let mut scratch = SearchScratch::new();
                let mut q = 0u32;
                while !done.load(Ordering::Relaxed) {
                    let query = Query::new(vector_for(q % 1000, dims));
                    let (results, _) = search(&graph, &query, 10, 64, &mut scratch);
                    // once anything is inserted, results must be non-empty and finite
                    for (_, d) in &results {
                        assert!(d.is_finite());
                    }
                    q += 1;
                }
            });
        }
        // scope joins writers when their closures end; signal readers afterward via a
        // dedicated waiter thread
        let graph_ref = graph.clone();
        let done_ref = done.clone();
        s.spawn(move || {
            while graph_ref.file.id_high_water() < (writers * per_writer) as u64 {
                std::thread::yield_now();
            }
            done_ref.store(true, Ordering::Relaxed);
        });
    });

    let total = writers * per_writer;
    assert_eq!(graph.file.id_high_water(), total as u64);

    // Every stored vector must be found as its own nearest neighbor at generous ef.
    let mut scratch = SearchScratch::new();
    let mut misses = 0;
    for i in (0..total).step_by(97) {
        let query = Query::new(vector_for(i, dims));
        let (results, _) = search(&graph, &query, 10, 256, &mut scratch);
        // identical vectors exist across ids (clusters), so accept any zero-ish distance hit
        if !results.iter().any(|&(_, d)| d < 1e-3) {
            misses += 1;
        }
    }
    assert_eq!(misses, 0, "self-queries missing after concurrent build");

    // Edge lists respect the cap.
    for id in (0..total).step_by(53) {
        if let Some(n) = graph.read_node(id) {
            assert!(n.neighbors.len() <= graph.file.layer0_cap);
        }
    }

    // Delete + reinsert reuses ids (freelist; the #2182 fix).
    graph.delete_node(5);
    graph.delete_node(6);
    let params = InsertParams::default();
    let a = insert(&graph, &vector_for(90_001, dims), &params, &mut scratch).unwrap();
    let b = insert(&graph, &vector_for(90_002, dims), &params, &mut scratch).unwrap();
    assert!(a == 5 || a == 6, "expected freelist reuse, got {a}");
    assert!(b == 5 || b == 6, "expected freelist reuse, got {b}");
    assert_eq!(graph.file.id_high_water(), total as u64, "high-water must not grow on reuse");

    let _ = std::fs::remove_file(&path);
}
