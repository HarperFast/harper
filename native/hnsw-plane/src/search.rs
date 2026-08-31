//! Beam search over the plane, zero-copy: per-visit cost is one seqlock-guarded distance
//! against mmap bytes plus primitive heap/visited ops. Visited tracking is an epoch-stamped
//! array; neighbor ids stream through a reusable scratch buffer.

use crate::distance::Query;
use crate::format::NO_ID;
use crate::graph::Graph;
use std::cmp::Ordering as CmpOrdering;
use std::collections::BinaryHeap;

#[derive(PartialEq)]
struct Candidate {
    distance: f32,
    id: u32,
}
impl Eq for Candidate {}
impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        // min-heap by distance via reverse
        other.distance.partial_cmp(&self.distance).unwrap_or(CmpOrdering::Equal)
    }
}
impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

#[derive(PartialEq)]
struct Result_ {
    distance: f32,
    id: u32,
}
impl Eq for Result_ {}
impl Ord for Result_ {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        // max-heap by distance (worst result on top for eviction)
        self.distance.partial_cmp(&other.distance).unwrap_or(CmpOrdering::Equal)
    }
}
impl PartialOrd for Result_ {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

/// Reusable per-thread search scratch.
pub struct SearchScratch {
    visited: Vec<u32>,
    epoch: u32,
    neighbors: Vec<u32>,
}

impl SearchScratch {
    pub fn new() -> Self {
        SearchScratch { visited: Vec::new(), epoch: 0, neighbors: Vec::new() }
    }

    pub fn begin_public(&mut self, capacity: u64) {
        self.begin(capacity)
    }

    fn begin(&mut self, capacity: u64) {
        if self.visited.len() < capacity as usize {
            self.visited.resize(capacity as usize, 0);
        }
        self.epoch = self.epoch.wrapping_add(1);
        if self.epoch == 0 {
            self.visited.fill(0);
            self.epoch = 1;
        }
    }

    #[inline]
    fn visit(&mut self, id: u32) -> bool {
        // ids minted by concurrent inserts after begin() can exceed the sizing snapshot;
        // growth is bounded by the id itself, which write paths bound by max_nodes
        if id as usize >= self.visited.len() {
            self.visited.resize(id as usize + 1024, 0);
        }
        let slot = &mut self.visited[id as usize];
        if *slot == self.epoch {
            false
        } else {
            *slot = self.epoch;
            true
        }
    }
}

impl Default for SearchScratch {
    fn default() -> Self {
        Self::new()
    }
}

pub struct SearchStats {
    pub visits: u64,
}

#[inline]
fn bit_allowed(filter: Option<&[u8]>, id: u32) -> bool {
    match filter {
        None => true,
        Some(bits) => {
            let byte = (id >> 3) as usize;
            byte < bits.len() && bits[byte] & (1 << (id & 7)) != 0
        }
    }
}

/// Beam search within one layer, starting from `entry`. Level 0 reads slot adjacency;
/// upper levels read the resident upper map. Returns (id, distance) ascending by distance.
/// Assumes scratch.begin() was called for this query; entry is marked visited here.
///
/// `filter`: optional allow-bitset over node ids (bit i of byte i>>3). Filtered-out nodes
/// are traversed (their edges route) but excluded from results — ACORN-style — with
/// `visit_budget` bounding total visits so a selective filter terminates.
pub fn search_layer(
    graph: &Graph,
    query: &Query,
    entry: u32,
    entry_dist: f32,
    ef: usize,
    level: u8,
    scratch: &mut SearchScratch,
    stats: &mut SearchStats,
    filter: Option<&[u8]>,
    visit_budget: u64,
) -> Vec<(u32, f32)> {
    let mut candidates = BinaryHeap::new();
    let mut results: BinaryHeap<Result_> = BinaryHeap::new();
    scratch.visit(entry);
    candidates.push(Candidate { distance: entry_dist, id: entry });
    if bit_allowed(filter, entry) {
        results.push(Result_ { distance: entry_dist, id: entry });
    }

    // take() the scratch neighbor buffer to sidestep the double-borrow of scratch
    let mut nbuf = std::mem::take(&mut scratch.neighbors);

    while let Some(c) = candidates.pop() {
        let worst = results.peek().map(|r| r.distance).unwrap_or(f32::INFINITY);
        if results.len() >= ef && c.distance > worst {
            break;
        }
        if stats.visits >= visit_budget {
            break;
        }
        if level == 0 {
            if graph.neighbors_into(c.id, &mut nbuf).is_none() {
                continue;
            }
        } else {
            graph.upper_neighbors_into(c.id, level, &mut nbuf);
        }
        for i in 0..nbuf.len() {
            let nid = nbuf[i];
            if !scratch.visit(nid) {
                continue;
            }
            if let Some(d) = graph.distance_to(nid, query) {
                stats.visits += 1;
                let worst = results.peek().map(|r| r.distance).unwrap_or(f32::INFINITY);
                if results.len() < ef || d < worst {
                    candidates.push(Candidate { distance: d, id: nid });
                    if bit_allowed(filter, nid) {
                        results.push(Result_ { distance: d, id: nid });
                        if results.len() > ef {
                            results.pop();
                        }
                    }
                }
            }
        }
    }
    scratch.neighbors = nbuf;

    let mut out: Vec<(u32, f32)> = results.into_iter().map(|r| (r.id, r.distance)).collect();
    out.sort_by(|a, b| a.1.total_cmp(&b.1));
    out
}

/// Greedy single-candidate descent through upper layers from `from_level` down to
/// `to_level` (exclusive lower bound handled by caller loops). Returns improved entry.
pub fn greedy_descend(
    graph: &Graph,
    query: &Query,
    mut current: u32,
    mut current_dist: f32,
    from_level: u32,
    to_level: u32,
    stats: &mut SearchStats,
) -> (u32, f32) {
    let mut nbuf: Vec<u32> = Vec::new();
    let mut level = from_level;
    while level > to_level {
        let mut improved = true;
        while improved {
            improved = false;
            graph.upper_neighbors_into(current, level.min(255) as u8, &mut nbuf);
            for i in 0..nbuf.len() {
                let nid = nbuf[i];
                if let Some(d) = graph.distance_to(nid, query) {
                    stats.visits += 1;
                    if d < current_dist {
                        current = nid;
                        current_dist = d;
                        improved = true;
                    }
                }
            }
        }
        level -= 1;
    }
    (current, current_dist)
}

/// Full search: greedy descent through upper layers, then beam at layer 0.
pub fn search(
    graph: &Graph,
    query: &Query,
    k: usize,
    ef: usize,
    scratch: &mut SearchScratch,
) -> (Vec<(u32, f32)>, SearchStats) {
    let mut stats = SearchStats { visits: 0 };
    let (entry_id, entry_level) = graph.file.entry_point();
    if entry_id == NO_ID {
        return (Vec::new(), stats);
    }
    scratch.begin(graph.file.id_high_water());

    let entry_dist = match graph.distance_to(entry_id, query) {
        Some(d) => {
            stats.visits += 1;
            d
        }
        None => return (Vec::new(), stats),
    };
    let (ep, ep_dist) = greedy_descend(graph, query, entry_id, entry_dist, entry_level, 0, &mut stats);
    let mut out = search_layer(graph, query, ep, ep_dist, ef, 0, scratch, &mut stats, None, u64::MAX);
    out.truncate(k);
    (out, stats)
}

/// Full search with an optional allow-bitset filter. `filter_expansion` multiplies ef into
/// the visit budget when a filter is present (matching the JS filterExpansion semantics).
pub fn search_filtered(
    graph: &Graph,
    query: &Query,
    k: usize,
    ef: usize,
    filter: Option<&[u8]>,
    filter_expansion: usize,
    scratch: &mut SearchScratch,
) -> (Vec<(u32, f32)>, SearchStats) {
    let mut stats = SearchStats { visits: 0 };
    let (entry_id, entry_level) = graph.file.entry_point();
    if entry_id == NO_ID {
        return (Vec::new(), stats);
    }
    scratch.begin_public(graph.file.id_high_water());
    let entry_dist = match graph.distance_to(entry_id, query) {
        Some(d) => {
            stats.visits += 1;
            d
        }
        None => return (Vec::new(), stats),
    };
    let (ep, ep_dist) = greedy_descend(graph, query, entry_id, entry_dist, entry_level, 0, &mut stats);
    let budget = if filter.is_some() { (ef * filter_expansion) as u64 } else { u64::MAX };
    let mut out = search_layer(graph, query, ep, ep_dist, ef, 0, scratch, &mut stats, filter, budget);
    out.truncate(k);
    (out, stats)
}

/// Pipelined predicate filtering: candidate ids are batched to an external evaluator (the
/// NAPI layer wires this to a JS ThreadsafeFunction) while traversal continues expanding —
/// the search thread never blocks on the evaluator until the beam itself is done. Verdicts
/// steer result admission only; routing uses pure distance order, bounded by the visit
/// budget, so a slow or saturated JS loop degrades speculative overshoot, not correctness.
pub struct PredicatePipe {
    /// Sends one batch of ids for evaluation. Must not block.
    pub dispatch: Box<dyn FnMut(Vec<u32>) + Send>,
    /// Receives (ids, verdicts) pairs; verdicts[i] != 0 admits ids[i].
    pub rx: std::sync::mpsc::Receiver<(Vec<u32>, Vec<u8>)>,
}

const PREDICATE_BATCH: usize = 64;
const DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Full search with a pipelined predicate filter (upper-layer descent is unfiltered, as in
/// the JS implementation — predicates gate results, not routing). `visit_budget` is the
/// absolute layer-0 visit cap: hosts pass their own resolved budget directly, since a
/// multiplier-of-ef encoding cannot express a budget below ef.
pub fn search_predicated(
    graph: &Graph,
    query: &Query,
    k: usize,
    ef: usize,
    pipe: &mut PredicatePipe,
    visit_budget: u64,
    scratch: &mut SearchScratch,
) -> (Vec<(u32, f32)>, SearchStats) {
    let mut stats = SearchStats { visits: 0 };
    let (entry_id, entry_level) = graph.file.entry_point();
    if entry_id == NO_ID {
        return (Vec::new(), stats);
    }
    scratch.begin_public(graph.file.id_high_water());
    let entry_dist = match graph.distance_to(entry_id, query) {
        Some(d) => {
            stats.visits += 1;
            d
        }
        None => return (Vec::new(), stats),
    };
    let (ep, ep_dist) = greedy_descend(graph, query, entry_id, entry_dist, entry_level, 0, &mut stats);

    use std::collections::HashMap;
    let mut verdicts: HashMap<u32, bool> = HashMap::new();
    let mut speculative: Vec<(u32, f32)> = Vec::new(); // awaiting verdicts
    let mut batch: Vec<u32> = Vec::new();
    let mut outstanding = 0usize;

    let mut candidates = BinaryHeap::new();
    let mut results: BinaryHeap<Result_> = BinaryHeap::new();
    scratch.visit(ep);
    candidates.push(Candidate { distance: ep_dist, id: ep });
    speculative.push((ep, ep_dist));
    batch.push(ep);

    let mut nbuf = std::mem::take(&mut scratch.neighbors);

    macro_rules! drain {
        ($recv:expr) => {
            while let Ok((ids, flags)) = $recv {
                outstanding -= 1;
                for (i, id) in ids.iter().enumerate() {
                    verdicts.insert(*id, flags.get(i).copied().unwrap_or(0) != 0);
                }
            }
        };
    }

    loop {
        // non-blocking verdict intake each iteration
        drain!(pipe.rx.try_recv());
        if !verdicts.is_empty() && !speculative.is_empty() {
            speculative.retain(|&(id, d)| match verdicts.get(&id) {
                Some(true) => {
                    results.push(Result_ { distance: d, id });
                    if results.len() > ef {
                        results.pop();
                    }
                    false
                }
                Some(false) => false,
                None => true,
            });
        }

        let Some(c) = candidates.pop() else { break };
        let worst = results.peek().map(|r| r.distance).unwrap_or(f32::INFINITY);
        if results.len() >= ef && c.distance > worst {
            break;
        }
        if stats.visits >= visit_budget {
            break;
        }
        if graph.neighbors_into(c.id, &mut nbuf).is_none() {
            continue;
        }
        for i in 0..nbuf.len() {
            let nid = nbuf[i];
            if !scratch.visit(nid) {
                continue;
            }
            if let Some(d) = graph.distance_to(nid, query) {
                stats.visits += 1;
                let worst = results.peek().map(|r| r.distance).unwrap_or(f32::INFINITY);
                if results.len() < ef || d < worst {
                    candidates.push(Candidate { distance: d, id: nid });
                    speculative.push((nid, d));
                    batch.push(nid);
                    if batch.len() >= PREDICATE_BATCH {
                        (pipe.dispatch)(std::mem::take(&mut batch));
                        outstanding += 1;
                    }
                }
            }
        }
    }
    scratch.neighbors = nbuf;

    // flush the tail batch and block-drain what's still in flight
    if !batch.is_empty() {
        (pipe.dispatch)(std::mem::take(&mut batch));
        outstanding += 1;
    }
    let deadline = std::time::Instant::now() + DRAIN_TIMEOUT;
    while outstanding > 0 && std::time::Instant::now() < deadline {
        drain!(pipe.rx.recv_timeout(std::time::Duration::from_millis(50)));
    }
    speculative.retain(|&(id, d)| {
        if verdicts.get(&id).copied().unwrap_or(false) {
            results.push(Result_ { distance: d, id });
            if results.len() > ef {
                results.pop();
            }
        }
        false
    });

    let mut out: Vec<(u32, f32)> = results.into_iter().map(|r| (r.id, r.distance)).collect();
    out.sort_by(|a, b| a.1.total_cmp(&b.1));
    out.truncate(k);
    (out, stats)
}

#[cfg(test)]
mod predicate_tests {
    use super::*;
    use crate::insert::{insert, InsertParams};
    use crate::PlaneFile;

    #[test]
    fn pipelined_predicate_filters_results() {
        let dims = 32;
        let path = std::env::temp_dir().join(format!("hnsw-pred-{}.hnsw", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let file = PlaneFile::create(&path, dims, 16, 4_096).expect("create");
        let graph = Graph::new(file);
        let params = InsertParams::default();
        let mut scratch = SearchScratch::new();
        for i in 0..1_000u32 {
            let v: Vec<f32> = (0..dims).map(|d| ((i as f32 * 0.31 + d as f32) * 0.7).sin()).collect();
            insert(&graph, &v, &params, &mut scratch).unwrap();
        }

        // evaluator thread: admit even ids only, answering over a channel like the TSFN does
        let (req_tx, req_rx) = std::sync::mpsc::channel::<Vec<u32>>();
        let (res_tx, res_rx) = std::sync::mpsc::channel::<(Vec<u32>, Vec<u8>)>();
        let worker = std::thread::spawn(move || {
            while let Ok(ids) = req_rx.recv() {
                let verdicts: Vec<u8> = ids.iter().map(|id| (id % 2 == 0) as u8).collect();
                if res_tx.send((ids, verdicts)).is_err() {
                    break;
                }
            }
        });

        let mut pipe = PredicatePipe {
            dispatch: Box::new(move |ids| {
                let _ = req_tx.send(ids);
            }),
            rx: res_rx,
        };
        let q: Vec<f32> = (0..dims).map(|d| ((41.0f32 * 0.31 + d as f32) * 0.7).sin()).collect();
        let (hits, _) =
            search_predicated(&graph, &Query::new(q), 10, 64, &mut pipe, 64 * 24, &mut scratch);
        assert!(!hits.is_empty());
        for (id, _) in &hits {
            assert_eq!(id % 2, 0, "odd id {id} leaked through the predicate");
        }
        drop(pipe);
        worker.join().unwrap();
        let _ = std::fs::remove_file(&path);
    }
}
