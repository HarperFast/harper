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

fn await_lock(held: &std::sync::atomic::AtomicBool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !held.load(std::sync::atomic::Ordering::Acquire) {
        assert!(std::time::Instant::now() < deadline, "holder thread never acquired the lock");
        std::hint::spin_loop();
    }
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
                })
                .expect("the holder must actually take the lock, or the test proves nothing");
            held2.store(true, O::Release);
            std::thread::sleep(std::time::Duration::from_millis(30)); // past TAKEOVER_AFTER
            drop(guard);
        });
        await_lock(&held);
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

/// Nothing references a freshly allocated upper entry until its write lands, so a path that
/// gives up on a wedged slot lock without freeing strands it outside both the freelist and the
/// graph.
#[test]
fn a_wedged_untouched_write_frees_its_upper_entry() {
    use std::sync::atomic::Ordering as O;
    let dims = 32;
    let path = tmp("wedgeuntouched");
    let _ = std::fs::remove_file(&path);
    let graph = std::sync::Arc::new(Graph::new(PlaneFile::create(&path, dims, 16, 64).expect("create")));
    let write = |id: u32| {
        let q = hnsw_plane::distance::quantize_int8(&vector_for(id, dims));
        graph.write_node_if_untouched(id, 1, &q.0, q.1, q.2, &[1, 2], &[vec![id]])
    };

    assert_eq!(write(1), Ok(true));
    let baseline = graph.file.upper_high_water();

    let seq9 = graph.file.seq_atomic(9) as *const _ as usize;
    let g2 = graph.clone();
    let held = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let held2 = held.clone();
    let hold = std::thread::spawn(move || {
        let seq = unsafe { &*(seq9 as *const std::sync::atomic::AtomicU32) };
        let g2 = &g2;
        let guard = hnsw_plane::seqlock::write_lock(seq, g2.file.self_tag, || panic!("live owner sanitized"), |tag| {
            g2.file.tag_is_dead(tag)
        })
        .expect("the holder must actually take the lock, or the test proves nothing");
        held2.store(true, O::Release);
        std::thread::sleep(std::time::Duration::from_millis(6_500)); // past WRITE_WEDGE_AFTER
        drop(guard);
    });
    await_lock(&held);
    assert_eq!(write(9), Err(hnsw_plane::seqlock::Wedged), "the held lock must wedge this write");
    hold.join().unwrap();

    assert_eq!(write(2), Ok(true));
    assert_eq!(
        graph.file.upper_high_water(),
        baseline + 1,
        "the wedged write leaked its upper entry instead of returning it to the freelist"
    );
    let _ = std::fs::remove_file(&path);
}

/// A wedged upper-entry cleanup must not leave the header naming a deleted entry point: the
/// cleanup is fallible, so an early return there strands every search on a dead entry. Asserts
/// the observable (searches still return hits), not the header word.
#[test]
fn a_wedged_upper_cleanup_still_reelects_the_entry_point() {
    use std::sync::atomic::Ordering as O;
    let dims = 32;
    let path = tmp("wedgedelete");
    let _ = std::fs::remove_file(&path);
    let graph = std::sync::Arc::new(Graph::new(PlaneFile::create(&path, dims, 16, 64).expect("create")));
    let raw = |id: u32, level: u8, neighbors: &[u32], upper: &[Vec<u32>]| {
        let q = hnsw_plane::distance::quantize_int8(&vector_for(id, dims));
        graph.write_node_raw(id, level, &q.0, q.1, q.2, neighbors, upper).expect("mirror");
    };
    // node 0 is the entry point and the only node with a hierarchy, so it owns upper entry 0
    raw(0, 1, &[1], &[vec![1]]);
    raw(1, 0, &[0], &[]);
    graph.file.set_entry_point(0, 1);

    let upper_seq = graph.file.upper_seq_atomic(0) as *const _ as usize;
    let g2 = graph.clone();
    let held = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let held2 = held.clone();
    let hold = std::thread::spawn(move || {
        let seq = unsafe { &*(upper_seq as *const std::sync::atomic::AtomicU32) };
        let g2 = &g2;
        let guard = hnsw_plane::seqlock::write_lock(seq, g2.file.self_tag, || panic!("live owner sanitized"), |tag| {
            g2.file.tag_is_dead(tag)
        })
        .expect("the holder must actually take the lock, or the test proves nothing");
        held2.store(true, O::Release);
        std::thread::sleep(std::time::Duration::from_millis(6_500)); // past WRITE_WEDGE_AFTER
        drop(guard);
    });
    await_lock(&held);
    assert_eq!(graph.delete_node(0), Err(hnsw_plane::seqlock::Wedged), "the held upper lock must wedge the cleanup");
    hold.join().unwrap();

    assert_eq!(graph.file.entry_point().0, 1, "the entry point must be re-elected before the fallible cleanup");
    let mut scratch = SearchScratch::new();
    let (hits, _) = search(&graph, &Query::new(vector_for(1, dims)), 5, 64, &mut scratch);
    assert!(!hits.is_empty(), "searches must keep working after a wedged delete of the entry point");
    let _ = std::fs::remove_file(&path);
}

/// A search must repair an entry point that no writer will: a host that cleared the entry, or
/// a slot a reader sanitized after its writer died, leaves no delete to run the write-path
/// re-election, so on a read-mostly table every search returns empty indefinitely.
#[test]
fn search_repairs_an_entry_point_no_writer_will() {
    let dims = 32;
    let path = tmp("entryheal");
    let _ = std::fs::remove_file(&path);
    let graph = Graph::new(PlaneFile::create(&path, dims, 16, 1_024).expect("create"));
    let params = InsertParams::default();
    let mut scratch = SearchScratch::new();
    for i in 0..200 {
        insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
    }
    let prev = graph.file.previous_entry_point();
    assert_ne!(prev, hnsw_plane::format::NO_ID, "promotions must record a previous-entry hint to repair from");

    // the entry's slot reads as gone with no delete having run (dead-writer sanitization, or a
    // mirroring host clearing the node) — nothing on the write path will ever re-elect
    let (entry, _) = graph.file.entry_point();
    graph.clear_node(entry).expect("tombstone the entry slot");

    let (hits, _) = search(&graph, &Query::new(vector_for(7, dims)), 5, 64, &mut scratch);
    assert!(!hits.is_empty(), "a search must self-heal past a dead entry point instead of returning empty");
    assert_ne!(graph.file.entry_point().0, entry, "the repair must be published, not repeated per search");
    let _ = std::fs::remove_file(&path);
}

/// `invalidate` demotes a plane that already looks like a complete mirror back to "incomplete,
/// rebuild me", and reports barrier failure to its caller instead of into a dropped promise —
/// which is what lets the host order it before creating a `.stale` sidecar. (Durability itself
/// is not observable in-process: the mapping is MAP_SHARED, so every store is already visible to
/// a reopen and to `read()` whether or not the msync ran. The ordering that a crash would expose
/// is asserted on the host side, in `vectorIndexPlane.test.js`.)
#[test]
fn invalidate_demotes_a_complete_looking_mirror_and_reports_failure() {
    let dims = 32;
    let path = tmp("invalidate");
    let _ = std::fs::remove_file(&path);
    {
        let graph = Graph::new(PlaneFile::create(&path, dims, 16, 1_024).expect("create"));
        let params = InsertParams::default();
        let mut scratch = SearchScratch::new();
        for i in 0..50 {
            insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
        }
        graph.file.flush_with_watermark(Some(4_096)).expect("barrier");
        assert_eq!(graph.file.watermark(), 4_096, "precondition: a complete-looking mirror");
        graph.file.invalidate().expect("invalidate must report its barrier, not swallow it");
        assert_eq!(graph.file.watermark(), 0, "invalidation must mark the mirror incomplete in band");
    }
    let reopened = PlaneFile::open(&path).expect("reopen");
    assert_eq!(reopened.watermark(), 0, "a fresh opener must see the incomplete mark, not the old stamp");
    let _ = std::fs::remove_file(&path);
}

/// The hint is one slot and can die too: promote over a node, then lose BOTH that node and the
/// entry it was promoted over. Without the bounded probe the repair has nowhere left to look and
/// every later search returns empty although most of the graph is live.
#[test]
fn search_repairs_an_entry_point_whose_hint_is_dead_too() {
    let dims = 32;
    let path = tmp("entryhealdeadhint");
    let _ = std::fs::remove_file(&path);
    let graph = Graph::new(PlaneFile::create(&path, dims, 16, 1_024).expect("create"));
    let params = InsertParams::default();
    let mut scratch = SearchScratch::new();
    for i in 0..200 {
        insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
    }
    let hint = graph.file.previous_entry_point();
    assert_ne!(hint, hnsw_plane::format::NO_ID, "precondition: a hint to invalidate");
    let (entry, _) = graph.file.entry_point();

    // both sanitized with no delete having run, so no write-path re-election ever happens and
    // the hint the repair would follow names a node that reads as gone
    graph.clear_node(hint).expect("tombstone the hint slot");
    graph.clear_node(entry).expect("tombstone the entry slot");

    let (hits, _) = search(&graph, &Query::new(vector_for(7, dims)), 5, 64, &mut scratch);
    assert!(!hits.is_empty(), "a dead hint must fall back to the bounded probe, not return empty forever");
    let repaired = graph.file.entry_point().0;
    assert_ne!(repaired, entry, "the repair must be published");
    assert_ne!(repaired, hint, "the repair must not publish the dead hint");
    let _ = std::fs::remove_file(&path);
}

/// Harper allocates node ids monotonically and never reuses them, so a table that has churned
/// has its whole low prefix tombstoned and only the newest ids live. A repair that probed a
/// fixed prefix would find nothing there and every search would return empty forever.
#[test]
fn search_repairs_an_entry_point_in_a_churned_graph_whose_low_ids_are_all_dead() {
    let dims = 32;
    let path = tmp("entryhealchurn");
    let _ = std::fs::remove_file(&path);
    let graph = Graph::new(PlaneFile::create(&path, dims, 16, 4_096).expect("create"));
    let params = InsertParams::default();
    let mut scratch = SearchScratch::new();
    for i in 0..1_200 {
        insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
    }
    // every id a prefix probe would reach is gone, as it is for any long-lived churned table
    for id in 0..1_100u32 {
        let _ = graph.clear_node(id);
    }
    let (entry, _) = graph.file.entry_point();
    let hint = graph.file.previous_entry_point();
    let _ = graph.clear_node(entry);
    if hint != hnsw_plane::format::NO_ID {
        let _ = graph.clear_node(hint);
    }

    let (hits, _) = search(&graph, &Query::new(vector_for(1_150, dims)), 5, 64, &mut scratch);
    assert!(!hits.is_empty(), "the probe must reach the live tail, not only a dead low prefix");
    let repaired = graph.file.entry_point().0;
    assert!(graph.read_node(repaired).is_some(), "the repair must publish a live node");
    let _ = std::fs::remove_file(&path);
}

/// A repair publishes with a strict CAS on the entry it observed dead. A first insert that
/// claims the header in between owns the graph, and a higher-level repair candidate must lose to
/// it — installing the candidate would leave that insert's node with nothing pointing at it.
#[test]
fn a_repair_never_displaces_a_root_installed_while_it_ran() {
    let dims = 32;
    let path = tmp("entryhealrace");
    let _ = std::fs::remove_file(&path);
    let graph = Graph::new(PlaneFile::create(&path, dims, 16, 1_024).expect("create"));
    let params = InsertParams::default();
    let mut scratch = SearchScratch::new();
    for i in 0..64 {
        insert(&graph, &vector_for(i, dims), &params, &mut scratch).unwrap();
    }
    let (observed, _) = graph.file.entry_point();
    let candidate = (0..64u32)
        .find(|&id| id != observed && id != 7 && graph.read_node(id).is_some())
        .expect("a live repair candidate");
    let candidate_level = graph.read_node(candidate).expect("live").level;
    assert!(graph.read_node(7).is_some(), "precondition: the racing root is a live node");

    // the interleaving a repair races: the header no longer names the entry it read
    graph.file.set_entry_point(7, 0);
    assert!(
        !graph.file.replace_entry_if(observed, candidate, candidate_level as u32),
        "a repair must not publish over an entry installed after it read the dead one"
    );
    assert_eq!(graph.file.entry_point().0, 7, "the root installed meanwhile stays");

    // and it does publish when nothing raced it
    let (current, _) = graph.file.entry_point();
    assert!(graph.file.replace_entry_if(current, candidate, candidate_level as u32));
    assert_eq!(graph.file.entry_point().0, candidate);
    let _ = std::fs::remove_file(&path);
}
