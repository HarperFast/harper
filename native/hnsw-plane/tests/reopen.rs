//! Crash-window and lifecycle coverage: torn-seqlock scrub on unclean reopen, entry-point
//! deletion recovery, truncated-file rejection, and full-plane behavior. These are the paths
//! a test that never crashes cannot verify.

use hnsw_plane::distance::Query;
use hnsw_plane::insert::{insert, InsertParams};
use hnsw_plane::search::{search, SearchScratch};
use hnsw_plane::{Graph, PlaneFile};
use std::sync::atomic::Ordering;

fn vector_for(i: u32, dims: usize) -> Vec<f32> {
    (0..dims).map(|d| ((i as f32 * 0.31 + d as f32) * 0.7).sin()).collect()
}

fn tmp(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("hnsw-{name}-{}.hnsw", std::process::id()))
}

#[test]
fn torn_seqlock_is_scrubbed_on_unclean_reopen() {
    let dims = 32;
    let path = tmp("torn");
    let _ = std::fs::remove_file(&path);
    {
        let graph = Graph::new(PlaneFile::create(&path, dims, 16, 1_024).expect("create"));
        let params = InsertParams::default();
        let mut scratch = SearchScratch::new();
        for i in 0..200 {
            insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
        }
        // simulate a writer killed mid-write: leave one slot's seqlock odd on disk
        graph.file.seq_atomic(7).fetch_add(1, Ordering::SeqCst);
        assert_eq!(graph.file.seq_atomic(7).load(Ordering::SeqCst) & 1, 1);
        graph.file.msync().unwrap();
        // dropped without flush_with_watermark => clean-shutdown flag stays dirty
    }
    let graph = Graph::new(PlaneFile::open(&path).expect("reopen"));
    assert_eq!(
        graph.file.seq_atomic(7).load(Ordering::SeqCst) & 1,
        0,
        "unclean reopen must scrub persisted-odd seqlocks or the slot wedges forever"
    );
    // the slot is readable and the graph searches
    assert!(graph.read_node(7).is_some());
    let mut scratch = SearchScratch::new();
    let (hits, _) = search(&graph, &Query::new(vector_for(7, dims)), 5, 64, &mut scratch);
    assert!(hits.iter().any(|&(_, d)| d < 1e-3), "torn slot's vector must be findable after scrub");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn deleting_the_entry_point_reelects_and_recovers() {
    let dims = 32;
    let path = tmp("entrydel");
    let _ = std::fs::remove_file(&path);
    let graph = Graph::new(PlaneFile::create(&path, dims, 16, 1_024).expect("create"));
    let params = InsertParams::default();
    let mut scratch = SearchScratch::new();
    for i in 0..100 {
        insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
    }
    let (entry, _) = graph.file.entry_point();
    graph.delete_node(entry);
    let (new_entry, _) = graph.file.entry_point();
    assert_ne!(new_entry, entry, "a new entry point must be elected");
    let (hits, _) = search(&graph, &Query::new(vector_for(3, dims)), 5, 64, &mut scratch);
    assert!(!hits.is_empty(), "search must survive entry-point deletion");
    // subsequent inserts must not orphan themselves against the dead entry
    let id = insert(&graph, &vector_for(500, dims), &params, &mut scratch).unwrap();
    let (hits, _) = search(&graph, &Query::new(vector_for(500, dims)), 5, 128, &mut scratch);
    assert!(hits.iter().any(|&(hid, d)| hid == id && d < 1e-3), "post-deletion insert must be reachable");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn truncated_file_is_a_catchable_error() {
    let path = tmp("trunc");
    std::fs::write(&path, vec![0u8; 100]).unwrap();
    assert!(PlaneFile::open(&path).is_err(), "a 100-byte file must be rejected, not panic");
    // header-valid but body-truncated: create a real plane, then cut it short
    let path2 = tmp("trunc2");
    let _ = std::fs::remove_file(&path2);
    {
        let graph = Graph::new(PlaneFile::create(&path2, 32, 16, 1_024).expect("create"));
        let params = InsertParams::default();
        let mut scratch = SearchScratch::new();
        insert(&graph, &vector_for(1, 32), &params, &mut scratch).unwrap();
    }
    let full = std::fs::metadata(&path2).unwrap().len();
    let f = std::fs::OpenOptions::new().write(true).open(&path2).unwrap();
    f.set_len(full / 2).unwrap();
    drop(f);
    assert!(PlaneFile::open(&path2).is_err(), "a body-truncated file must be rejected, not read off the map");
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&path2);
}

#[test]
fn full_plane_refuses_inserts_instead_of_corrupting() {
    let dims = 32;
    let path = tmp("full");
    let _ = std::fs::remove_file(&path);
    let graph = Graph::new(PlaneFile::create(&path, dims, 16, 8).expect("create"));
    let params = InsertParams::default();
    let mut scratch = SearchScratch::new();
    for i in 0..8 {
        assert!(insert(&graph, &vector_for(i, dims), &params, &mut scratch).is_some());
    }
    assert!(insert(&graph, &vector_for(9, dims), &params, &mut scratch).is_none(), "insert past maxNodes must fail cleanly");
    // freed capacity is usable again
    graph.delete_node(3);
    assert!(insert(&graph, &vector_for(10, dims), &params, &mut scratch).is_some());
    let _ = std::fs::remove_file(&path);
}
