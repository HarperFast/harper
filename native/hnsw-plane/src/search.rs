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

/// Beam search within one layer, starting from `entry`. Level 0 reads slot adjacency;
/// upper levels read the resident upper map. Returns (id, distance) ascending by distance.
/// Assumes scratch.begin() was called for this query; entry is marked visited here.
pub fn search_layer(
    graph: &Graph,
    query: &Query,
    entry: u32,
    entry_dist: f32,
    ef: usize,
    level: u8,
    scratch: &mut SearchScratch,
    stats: &mut SearchStats,
) -> Vec<(u32, f32)> {
    let mut candidates = BinaryHeap::new();
    let mut results: BinaryHeap<Result_> = BinaryHeap::new();
    scratch.visit(entry);
    candidates.push(Candidate { distance: entry_dist, id: entry });
    results.push(Result_ { distance: entry_dist, id: entry });

    // take() the scratch neighbor buffer to sidestep the double-borrow of scratch
    let mut nbuf = std::mem::take(&mut scratch.neighbors);

    while let Some(c) = candidates.pop() {
        let worst = results.peek().map(|r| r.distance).unwrap_or(f32::INFINITY);
        if results.len() >= ef && c.distance > worst {
            break;
        }
        if level == 0 {
            if graph.neighbors_into(c.id, &mut nbuf).is_none() {
                continue;
            }
        } else {
            nbuf.clear();
            let upper = graph.upper.read().unwrap();
            if let Some(levels) = upper.get(&c.id) {
                if let Some(list) = levels.get(level as usize - 1) {
                    nbuf.extend_from_slice(list);
                }
            }
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
                    results.push(Result_ { distance: d, id: nid });
                    if results.len() > ef {
                        results.pop();
                    }
                }
            }
        }
    }
    scratch.neighbors = nbuf;

    let mut out: Vec<(u32, f32)> = results.into_iter().map(|r| (r.id, r.distance)).collect();
    out.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(CmpOrdering::Equal));
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
    let upper = graph.upper.read().unwrap();
    let mut level = from_level;
    while level > to_level {
        let mut improved = true;
        while improved {
            improved = false;
            let neighbors = upper
                .get(&current)
                .and_then(|levels| levels.get(level as usize - 1))
                .cloned()
                .unwrap_or_default();
            for nid in neighbors {
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
    let mut out = search_layer(graph, query, ep, ep_dist, ef, 0, scratch, &mut stats);
    out.truncate(k);
    (out, stats)
}
