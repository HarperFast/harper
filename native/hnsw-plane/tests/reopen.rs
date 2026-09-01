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
        // simulate a writer killed mid-write: lock word = bit31 | a tag whose registry slot
        // carries no matching registration (the fabricated tag differs from any live tag,
        // so tag_is_dead reports it dead immediately)
        graph.file.seq_atomic(7).store((1 << 31) | 0x1234_5678 & 0x7fff_ffff, Ordering::SeqCst);
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
    graph.write_node_raw(7, 0, &q.0, q.1, q.2, &[3, 4], &[]).unwrap();
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
        let g2 = &g2;
        let guard = hnsw_plane::seqlock::write_lock(
            seq,
            g2.file.self_tag,
            || panic!("a live same-process writer must never be sanitized"),
            |tag| g2.file.tag_is_dead(tag),
        );
        std::thread::sleep(std::time::Duration::from_millis(120));
        drop(guard);
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
    let _ = graph.delete_node(5);
    let _ = graph.delete_node(5); // second delete must be a no-op, not a second freelist push
    let _ = graph.delete_node(2_000_000); // out-of-range must be a no-op, not an OOB write
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
    let _ = graph.delete_node(entry);
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
        assert!(insert(&graph, &vector_for(i, dims), &params, &mut scratch).is_ok());
    }
    assert!(insert(&graph, &vector_for(9, dims), &params, &mut scratch).is_err(), "insert past maxNodes must fail cleanly");
    // freed capacity is usable again
    let _ = graph.delete_node(3);
    assert!(insert(&graph, &vector_for(10, dims), &params, &mut scratch).is_ok());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn flush_without_watermark_preserves_a_completion_stamp() {
    let dims = 32;
    let path = tmp("flushnone");
    let _ = std::fs::remove_file(&path);
    let graph = Graph::new(PlaneFile::create(&path, dims, 16, 256).expect("create"));
    graph.file.set_watermark(7);
    graph.file.flush_with_watermark(None).unwrap();
    assert_eq!(graph.file.watermark(), 7, "a watermark-less barrier must not touch the stamp");
    graph.file.flush_with_watermark(Some(9)).unwrap();
    assert_eq!(graph.file.watermark(), 9);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn odd_dims_freelist_reuse_is_aligned() {
    // dims 25: the old freelist next-pointer at S_VECTOR+dims was unaligned (SIGBUS on
    // aarch64); it now lives at the dead slot's aligned scale field
    let dims = 25;
    let path = tmp("odddims");
    let _ = std::fs::remove_file(&path);
    let graph = Graph::new(PlaneFile::create(&path, dims, 16, 256).expect("create"));
    let params = InsertParams::default();
    let mut scratch = SearchScratch::new();
    for i in 0..20 {
        insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
    }
    let _ = graph.delete_node(4);
    let _ = graph.delete_node(9);
    let a = insert(&graph, &vector_for(50, dims), &params, &mut scratch).unwrap();
    let b = insert(&graph, &vector_for(51, dims), &params, &mut scratch).unwrap();
    assert!(a == 9 || a == 4);
    assert!(b == 9 || b == 4);
    assert_ne!(a, b);
    let _ = std::fs::remove_file(&path);
}

#[cfg(target_os = "linux")]
#[test]
fn same_pid_restart_takeover_via_registry() {
    // The container-pid-1 scenario: the process that died and the process that reopens have
    // the SAME pid, so pid-based liveness would wedge forever. Registry liveness is keyed to
    // the open handle (kernel lock dies with it), which a same-process reopen reproduces
    // faithfully: drop the old handle, reopen, and the old tag must be reclaimable.
    let dims = 32;
    let path = tmp("samepid");
    let _ = std::fs::remove_file(&path);
    let dead_tag;
    {
        let graph = Graph::new(PlaneFile::create(&path, dims, 16, 1_024).expect("create"));
        let params = InsertParams::default();
        let mut scratch = SearchScratch::new();
        for i in 0..100 {
            insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
        }
        dead_tag = graph.file.self_tag;
        assert_ne!(dead_tag, 0, "linux handles must register");
        // die mid-write: lock word carries OUR tag, then the handle drops (kernel releases
        // the registry lock exactly as process death would)
        graph.file.seq_atomic(11).store((1 << 31) | dead_tag, Ordering::SeqCst);
        graph.file.msync().unwrap();
    }
    let graph = Graph::new(PlaneFile::open(&path).expect("reopen"));
    assert_ne!(graph.file.self_tag, dead_tag, "a new handle mints a new tag");
    let start = std::time::Instant::now();
    assert!(graph.read_node(11).is_none(), "taken-over slot reads deleted (sanitized), not spliced");
    assert!(start.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(graph.file.seq_atomic(11).load(Ordering::SeqCst) >> 31, 0, "lock reclaimed");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn tombstoned_virgin_slot_does_not_alias_upper_entry_zero() {
    let dims = 32;
    let path = tmp("virgintomb");
    let _ = std::fs::remove_file(&path);
    let graph = Graph::new(PlaneFile::create(&path, dims, 16, 1_024).expect("create"));
    let params = InsertParams::default();
    let mut scratch = SearchScratch::new();
    // make node 0's insert claim upper entry 0 (first level>=1 node allocates it); insert
    // until some node has an upper entry
    let mut upper_owner = None;
    for i in 0..64 {
        let id = insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
        if graph.read_node(id).map(|n| n.level > 0).unwrap_or(false) {
            upper_owner = Some(id);
            break;
        }
    }
    let upper_owner = upper_owner.expect("some node should have an upper level");
    let mut before = Vec::new();
    assert!(graph.upper_neighbors_into(upper_owner, 1, &mut before) || before.is_empty());

    // tombstone a NEVER-written id (beyond anything inserted), then raw-write it with an
    // upper list: it must allocate a fresh entry, not adopt the zero-initialized index 0
    let virgin = 900;
    graph.clear_node(virgin).unwrap();
    let q = hnsw_plane::distance::quantize_int8(&vector_for(virgin, dims));
    graph
        .write_node_raw(virgin, 1, &q.0, q.1, q.2, &[1, 2], &[vec![1, 2]])
        .unwrap();
    let mut after = Vec::new();
    let _ = graph.upper_neighbors_into(upper_owner, 1, &mut after);
    assert_eq!(before, after, "raw-writing a tombstoned virgin slot must not clobber another node's upper entry");
    let mut virgin_upper = Vec::new();
    assert!(graph.upper_neighbors_into(virgin, 1, &mut virgin_upper));
    assert_eq!(virgin_upper, vec![1, 2]);
    let _ = std::fs::remove_file(&path);
}

/// The host's id counter reseeds to largestNodeId + 1 across a restart, so deleting the top
/// ids hands them back out and the new record redraws its level — often 0. The re-minted slot
/// must stop reading its predecessor's upper adjacency, and cycling a hot id through levels
/// must not consume a fresh entry each time.
#[test]
fn raw_rewrite_at_level_zero_clears_the_stale_hierarchy() {
    let dims = 32;
    let path = tmp("upperstale");
    let _ = std::fs::remove_file(&path);
    let graph = Graph::new(PlaneFile::create(&path, dims, 16, 64).expect("create"));
    let q = hnsw_plane::distance::quantize_int8(&vector_for(9, dims));
    let write = |level: u8, upper: &[Vec<u32>]| {
        graph.write_node_raw(9, level, &q.0, q.1, q.2, &[1, 2], upper).unwrap();
    };
    let mut nbrs = Vec::new();

    write(1, &[vec![7]]);
    assert!(graph.upper_neighbors_into(9, 1, &mut nbrs) && nbrs == vec![7]);
    write(0, &[]);
    assert!(!graph.upper_neighbors_into(9, 1, &mut nbrs), "a level-0 rewrite must not leave the old hierarchy readable");

    // cycling the same id through level 0 and back must reuse its entry, not mint one per pass
    for n in 0..graph.file.upper_capacity as u32 + 4 {
        write(1, &[vec![n % 8]]);
        write(0, &[]);
    }
    write(1, &[vec![5]]);
    assert!(
        graph.upper_neighbors_into(9, 1, &mut nbrs),
        "upper region exhausted: level cycling minted a new entry per pass"
    );
    assert_eq!(nbrs, vec![5]);
    let _ = std::fs::remove_file(&path);
}

/// A peer worker holding the slot lock past the 20 ms stale window makes the lock-free upper
/// read give up and report NO_UPPER. Treating that "cannot tell" as "nothing bound" mints a
/// second entry per contended mirror and orphans the first, so a hot node burns the fixed
/// upper region until level>=1 mirrors stop binding at all.
#[test]
fn contended_raw_rewrite_does_not_mint_a_second_upper_entry() {
    use std::sync::atomic::{AtomicBool, Ordering as O};
    let dims = 32;
    let path = tmp("uppercontend");
    let _ = std::fs::remove_file(&path);
    let graph = std::sync::Arc::new(Graph::new(PlaneFile::create(&path, dims, 16, 64).expect("create")));
    let q = hnsw_plane::distance::quantize_int8(&vector_for(9, dims));
    graph.write_node_raw(9, 1, &q.0, q.1, q.2, &[1, 2], &[vec![7]]).unwrap();

    let seq9 = graph.file.seq_atomic(9) as *const _ as usize;
    for n in 0..graph.file.upper_capacity as u32 + 4 {
        let g2 = graph.clone();
        let held = std::sync::Arc::new(AtomicBool::new(false));
        let held2 = held.clone();
        let hold = std::thread::spawn(move || {
            let seq = unsafe { &*(seq9 as *const std::sync::atomic::AtomicU32) };
            let g2 = &g2;
            let guard =
                hnsw_plane::seqlock::write_lock(seq, g2.file.self_tag, || panic!("live owner sanitized"), |tag| {
                    g2.file.tag_is_dead(tag)
                });
            held2.store(true, O::Release);
            std::thread::sleep(std::time::Duration::from_millis(30)); // past TAKEOVER_AFTER
            drop(guard);
        });
        while !held.load(O::Acquire) {
            std::hint::spin_loop(); // the mirror must arrive with the lock genuinely held
        }
        graph.write_node_raw(9, 1, &q.0, q.1, q.2, &[1, 2], &[vec![n % 8]]).unwrap();
        hold.join().unwrap();
    }

    let mut nbrs = Vec::new();
    assert!(
        graph.upper_neighbors_into(9, 1, &mut nbrs),
        "upper region exhausted: each contended rewrite minted and orphaned an entry"
    );
    let _ = std::fs::remove_file(&path);
}

/// The backfill scan allocates its upper entry before taking the slot lock, and nothing
/// references that entry until the write lands — so giving up on a wedged lock without freeing
/// strands it outside both the freelist and the graph. `upper_high_water` not advancing on the
/// next allocation is what proves it was reclaimed.
///
/// `write_node_raw`'s equivalent window (between `upper_idx_locked` releasing and `write_node`
/// re-acquiring) is guarded the same way but cannot be driven deterministically: a holder that
/// takes the lock first now wedges the read, before anything is allocated.
#[test]
fn a_wedged_untouched_write_frees_its_upper_entry() {
    use std::sync::atomic::{AtomicBool, Ordering as O};
    let dims = 32;
    let path = tmp("wedgeuntouched");
    let _ = std::fs::remove_file(&path);
    let graph = std::sync::Arc::new(Graph::new(PlaneFile::create(&path, dims, 16, 64).expect("create")));
    let write = |id: u32| {
        let q = hnsw_plane::distance::quantize_int8(&vector_for(id, dims));
        let _ = graph.write_node_if_untouched(id, 1, &q.0, q.1, q.2, &[1, 2], &[vec![id]]);
    };

    write(1);
    let baseline = graph.file.upper_high_water();

    let seq9 = graph.file.seq_atomic(9) as *const _ as usize;
    let g2 = graph.clone();
    let held = std::sync::Arc::new(AtomicBool::new(false));
    let held2 = held.clone();
    let hold = std::thread::spawn(move || {
        let seq = unsafe { &*(seq9 as *const std::sync::atomic::AtomicU32) };
        let g2 = &g2;
        let guard = hnsw_plane::seqlock::write_lock(seq, g2.file.self_tag, || panic!("live owner sanitized"), |tag| {
            g2.file.tag_is_dead(tag)
        });
        held2.store(true, O::Release);
        std::thread::sleep(std::time::Duration::from_millis(6_500)); // past WRITE_WEDGE_AFTER
        drop(guard);
    });
    while !held.load(O::Acquire) {
        std::hint::spin_loop();
    }
    write(9); // wedges on the slot lock, having already allocated an upper entry
    hold.join().unwrap();

    write(2);
    assert_eq!(
        graph.file.upper_high_water(),
        baseline + 1,
        "the wedged write leaked its upper entry instead of returning it to the freelist"
    );
    let _ = std::fs::remove_file(&path);
}
