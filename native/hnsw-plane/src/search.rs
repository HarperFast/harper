//! Beam search over the plane. Visited tracking is an epoch-stamped array (no per-query
//! allocation once warmed); candidate/result sets are simple binary heaps.

use crate::distance::{cosine_int8, Query};
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

/// Reusable per-thread search scratch: epoch-stamped visited array.
pub struct SearchScratch {
    visited: Vec<u32>,
    epoch: u32,
}

impl SearchScratch {
    pub fn new() -> Self {
        SearchScratch { visited: Vec::new(), epoch: 0 }
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

pub struct SearchStats {
    pub visits: u64,
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

    // Greedy descent: single-candidate walk from the top level down to level 1.
    let mut current = entry_id;
    let mut current_dist = match graph.read_node(current) {
        Some(n) => {
            stats.visits += 1;
            cosine_int8(query, &n.vector, n.scale, n.inv_mag)
        }
        None => return (Vec::new(), stats),
    };
    let upper = graph.upper.read().unwrap();
    for level in (1..=entry_level).rev() {
        let mut improved = true;
        while improved {
            improved = false;
            let neighbors = upper
                .get(&current)
                .and_then(|levels| levels.get(level as usize - 1))
                .cloned()
                .unwrap_or_default();
            for nid in neighbors {
                if let Some(n) = graph.read_node(nid) {
                    stats.visits += 1;
                    let d = cosine_int8(query, &n.vector, n.scale, n.inv_mag);
                    if d < current_dist {
                        current = nid;
                        current_dist = d;
                        improved = true;
                    }
                }
            }
        }
    }
    drop(upper);

    // Layer-0 beam.
    let mut candidates = BinaryHeap::new();
    let mut results: BinaryHeap<Result_> = BinaryHeap::new();
    scratch.visit(current);
    candidates.push(Candidate { distance: current_dist, id: current });
    results.push(Result_ { distance: current_dist, id: current });

    while let Some(c) = candidates.pop() {
        let worst = results.peek().map(|r| r.distance).unwrap_or(f32::INFINITY);
        if results.len() >= ef && c.distance > worst {
            break;
        }
        if let Some(node) = graph.read_node(c.id) {
            for nid in node.neighbors {
                if !scratch.visit(nid) {
                    continue;
                }
                if let Some(n) = graph.read_node(nid) {
                    stats.visits += 1;
                    let d = cosine_int8(query, &n.vector, n.scale, n.inv_mag);
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
    }

    let mut out: Vec<(u32, f32)> = results.into_iter().map(|r| (r.id, r.distance)).collect();
    out.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(CmpOrdering::Equal));
    out.truncate(k);
    (out, stats)
}
