//! Prototype insert: enough HNSW construction to build benchmark graphs. Neighbor selection
//! is plain closest-M (the JS optimizeRouting-aware selection is the parity target for the
//! phase-3 native insert; for per-visit cost measurement this suffices).

use crate::distance::{cosine_int8, quantize_int8, Query};
use crate::format::NO_ID;
use crate::graph::Graph;
use crate::search::{search, SearchScratch};

pub struct InsertParams {
    pub m: usize,               // upper-layer connections
    pub ef_construction: usize, // candidate list size
    pub ml: f64,                // level normalization: 1 / ln(M)
}

impl Default for InsertParams {
    fn default() -> Self {
        InsertParams { m: 16, ef_construction: 200, ml: 1.0 / (16f64).ln() }
    }
}

/// Deterministic pseudo-random level from the node id (parity with Math.random is not needed
/// for benchmarks; a hash keeps runs reproducible).
fn level_for(id: u32, ml: f64) -> u8 {
    let mut x = (id as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15).wrapping_add(0x2545_f491_4f6c_dd1d);
    x ^= x >> 33;
    let unit = (x as f64) / (u64::MAX as f64);
    let level = (-unit.max(f64::MIN_POSITIVE).ln() * ml).floor();
    level.min(31.0) as u8
}

pub fn insert(graph: &Graph, vector: &[f32], params: &InsertParams, scratch: &mut SearchScratch) -> u32 {
    let (bytes, scale, inv_mag) = quantize_int8(vector);
    let id = graph.file.allocate_id();
    let level = level_for(id, params.ml);
    let query = Query::new(vector.to_vec());

    let (entry_id, entry_level) = graph.file.entry_point();
    if entry_id == NO_ID {
        graph.write_node(id, level, &bytes, scale, inv_mag, &[]);
        if level > 0 {
            graph.upper.write().unwrap().insert(id, vec![Vec::new(); level as usize]);
        }
        graph.file.set_entry_point(id, level as u32);
        return id;
    }

    // Candidate discovery at layer 0.
    let (candidates, _) = search(graph, &query, params.ef_construction, params.ef_construction, scratch);
    let layer0_cap = graph.file.layer0_cap;
    let m0 = (params.m * 2).min(layer0_cap);
    let neighbors: Vec<u32> = candidates.iter().take(m0).map(|(nid, _)| *nid).collect();

    graph.write_node(id, level, &bytes, scale, inv_mag, &neighbors);

    // Reverse edges at layer 0, pruning the neighbor's list to cap by distance if full.
    for &nid in &neighbors {
        if let Some(n) = graph.read_node(nid) {
            let mut list = n.neighbors.clone();
            if list.contains(&id) {
                continue;
            }
            list.push(id);
            if list.len() > layer0_cap {
                let nq = Query::new(n.vector.iter().map(|v| *v as f32 * n.scale).collect());
                let mut scored: Vec<(u32, f32)> = list
                    .iter()
                    .filter_map(|&cand| {
                        graph.read_node(cand).map(|c| (cand, cosine_int8(&nq, &c.vector, c.scale, c.inv_mag)))
                    })
                    .collect();
                scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
                list = scored.into_iter().take(layer0_cap).map(|(cand, _)| cand).collect();
            }
            graph.write_neighbors(nid, &list);
        }
    }

    // Upper layers: link into per-level lists (prototype: closest-M from the candidate set).
    if level > 0 {
        let mut levels: Vec<Vec<u32>> = Vec::with_capacity(level as usize);
        let upper = graph.upper.read().unwrap();
        for l in 1..=level {
            let peers: Vec<u32> = candidates
                .iter()
                .filter(|(nid, _)| {
                    graph.read_node(*nid).map(|n| n.level >= l).unwrap_or(false) && upper.contains_key(nid)
                })
                .take(params.m)
                .map(|(nid, _)| *nid)
                .collect();
            levels.push(peers);
        }
        drop(upper);
        let mut upper = graph.upper.write().unwrap();
        for (l, peers) in levels.iter().enumerate() {
            for &peer in peers {
                if let Some(peer_levels) = upper.get_mut(&peer) {
                    if let Some(peer_list) = peer_levels.get_mut(l) {
                        if !peer_list.contains(&id) && peer_list.len() < params.m * 2 {
                            peer_list.push(id);
                        }
                    }
                }
            }
        }
        upper.insert(id, levels);
    }

    if (level as u32) > entry_level {
        graph.file.set_entry_point(id, level as u32);
    }
    id
}
