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
fn dead_writer_lock_is_taken_over_and_slot_sanitized() {
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
        // simulate a writer killed mid-write: lock word = bit31 | its (now dead) pid.
        // 0x7ff_fff0 exceeds Linux pid_max (4M) and any real pid space: kill() -> ESRCH.
        graph.file.seq_atomic(7).store((1 << 31) | 0x7ff_fff0, Ordering::SeqCst);
        graph.file.msync().unwrap();
    }
    let graph = Graph::new(PlaneFile::open(&path).expect("reopen"));
    // the first reader waits out the takeover window, confirms the owner is dead, takes the
    // lock over, and SANITIZES the slot: a dead writer's payload is half-written, so the
    // node must read as absent (heal-on-touch), never as a spliced-but-valid vector
    let start = std::time::Instant::now();
    assert!(graph.read_node(7).is_none(), "taken-over slot must read absent, not spliced");
    assert!(start.elapsed() < std::time::Duration::from_secs(5), "takeover must be fast");
    assert_eq!(graph.file.seq_atomic(7).load(Ordering::SeqCst) >> 31, 0, "takeover unlocks the slot");
    // the graph still searches (node 7 is just missing), and rewriting the slot heals it
    let mut scratch = SearchScratch::new();
    let (hits, _) = search(&graph, &Query::new(vector_for(3, dims)), 5, 64, &mut scratch);
    assert!(!hits.is_empty());
    let q = hnsw_plane::distance::quantize_int8(&vector_for(7, dims));
    graph.write_node_raw(7, 0, &q.0, q.1, q.2, &[3, 4], &[]);
    assert!(graph.read_node(7).is_some(), "a rewrite heals the sanitized slot");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn live_writer_is_never_robbed() {
    let dims = 32;
    let path = tmp("liverob");
    let _ = std::fs::remove_file(&path);
    let graph = std::sync::Arc::new(Graph::new(PlaneFile::create(&path, dims, 16, 1_024).expect("create")));
    let params = InsertParams::default();
    let mut scratch = SearchScratch::new();
    for i in 0..50 {
        insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
    }
    // a LIVE writer (this process) holds slot 9's lock far past the takeover window; readers
    // must wait or degrade to absent — never force the lock and never observe torn payload
    let seq9 = graph.file.seq_atomic(9) as *const _ as usize;
    let g2 = graph.clone();
    let hold = std::thread::spawn(move || {
        let seq = unsafe { &*(seq9 as *const std::sync::atomic::AtomicU32) };
        let guard = hnsw_plane::seqlock::write_lock(seq, || panic!("a live same-process writer must never be sanitized"));
        std::thread::sleep(std::time::Duration::from_millis(120));
        drop(guard);
        drop(g2);
    });
    std::thread::sleep(std::time::Duration::from_millis(30)); // reader arrives mid-hold
    let n9 = graph.read_node(9);
    // either it waited for the release (Some) or degraded to absent for this read (None) —
    // but the lock must have been RELEASED by the owner, not forced
    hold.join().unwrap();
    assert!(graph.read_node(9).is_some(), "the slot is intact after the live writer releases");
    let _ = n9;
    let _ = std::fs::remove_file(&path);
}

#[test]
fn double_remove_does_not_cycle_the_freelist() {
    let dims = 32;
    let path = tmp("dblrm");
    let _ = std::fs::remove_file(&path);
    let graph = Graph::new(PlaneFile::create(&path, dims, 16, 1_024).expect("create"));
    let params = InsertParams::default();
    let mut scratch = SearchScratch::new();
    for i in 0..20 {
        insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
    }
    graph.delete_node(5);
    graph.delete_node(5); // second delete must be a no-op, not a second freelist push
    graph.delete_node(2_000_000); // out-of-range must be a no-op, not an OOB write
    let a = insert(&graph, &vector_for(101, dims), &params, &mut scratch).unwrap();
    let b = insert(&graph, &vector_for(102, dims), &params, &mut scratch).unwrap();
    let c = insert(&graph, &vector_for(103, dims), &params, &mut scratch).unwrap();
    assert_eq!(a, 5, "freed id is reused once");
    assert_ne!(b, a, "a double-freed id must not be handed out twice");
    assert_ne!(c, b);
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
