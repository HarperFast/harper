//! HNSW insert with parity to the JS implementation's optimizeRouting selection
//! (HierarchicalNavigableSmallWorld.ts): candidate i is skipped when an already-added
//! connection reaches it indirectly at comparable cost, and inferior indirect edges are
//! replaced by the new direct route. Stored per-edge distances were dropped from the file
//! format, so neighbor↔neighbor distances are recomputed (int8×int8) on id-match hits only.

use crate::distance::{quantize_int8, Query};
use crate::format::{NO_ID, NO_UPPER};
use crate::graph::Graph;
use crate::search::{greedy_descend, search_layer, SearchScratch, SearchStats};

pub struct InsertParams {
    pub m: usize,               // base connection count (JS M, default 16)
    pub ef_construction: usize, // candidate list size
    pub ml: f64,                // level normalization: 1 / ln(M)
    pub optimize_routing: f32,  // JS optimizeRouting, default 0.5; 0 disables
}

impl Default for InsertParams {
    fn default() -> Self {
        InsertParams { m: 16, ef_construction: 200, ml: 1.0 / (16f64).ln(), optimize_routing: 0.5 }
    }
}

/// Deterministic pseudo-random level from the node id (reproducible benchmark builds).
fn level_for(id: u32, ml: f64) -> u8 {
    let mut x = (id as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15).wrapping_add(0x2545_f491_4f6c_dd1d);
    x ^= x >> 33;
    let unit = (x as f64) / (u64::MAX as f64);
    let level = (-unit.max(f64::MIN_POSITIVE).ln() * ml).floor();
    (level as u8).min(crate::format::MAX_UPPER_LEVELS as u8)
}

/// Remove `to` from `from`'s adjacency at `level` (edge-replacement maintenance).
fn remove_edge(graph: &Graph, from: u32, to: u32, level: u8) {
    if level == 0 {
        graph.update_neighbors(from, |list| {
            if let Some(pos) = list.iter().position(|&x| x == to) {
                list.remove(pos);
            }
        });
    } else {
        let _ = graph.update_upper_level(from, level, |list| {
            if let Some(pos) = list.iter().position(|&x| x == to) {
                list.remove(pos);
            }
        });
    }
}

/// Neighbor ids of `id` at `level` (level 0 from the slot, upper from the resident map).
fn neighbors_at(graph: &Graph, id: u32, level: u8, buf: &mut Vec<u32>) {
    if level == 0 {
        graph.neighbors_into(id, buf);
    } else {
        graph.upper_neighbors_into(id, level, buf);
    }
}

/// Prune an over-cap adjacency list by evicting the most REDUNDANT far member rather than
/// blindly the farthest: plain closest-keep can strip a node's last in-edge in dense
/// near-duplicate clusters, orphaning it from the graph (observed as unfindable self-queries
/// under concurrent builds). A far member e is redundant when some kept nearer member k has
/// d(e, k) < d(base, e) — searches reaching k still reach e. Bounded: farthest 16 candidates
/// checked against the nearest 16 keepers (~30us per overflow event); falls back to evicting
/// the plain farthest when nothing is provably redundant.
fn prune_with_coverage(graph: &Graph, base: u32, list: &mut Vec<u32>, cap: usize) {
    let mut scored: Vec<(u32, f32)> = list
        .iter()
        .filter_map(|&cand| graph.distance_between(base, cand).map(|d| (cand, d)))
        .collect();
    scored.sort_by(|a, b| a.1.total_cmp(&b.1));
    while scored.len() > cap {
        let check_from = scored.len().saturating_sub(16);
        let keepers = &scored[..16.min(check_from)];
        let mut evict = scored.len() - 1; // fallback: farthest
        'hunt: for i in (check_from..scored.len()).rev() {
            let (e, d_base_e) = scored[i];
            for &(k, _) in keepers {
                if k == e {
                    continue;
                }
                if let Some(d_ek) = graph.distance_between(e, k) {
                    if d_ek < d_base_e {
                        evict = i;
                        break 'hunt;
                    }
                }
            }
        }
        scored.remove(evict);
    }
    *list = scored.into_iter().map(|(cand, _)| cand).collect();
}

/// Add `new_id` to `nid`'s adjacency at `level`, coverage-pruning to `cap` when over. The
/// prune's distance computations (which can major-fault on a cold mapping) run OUTSIDE the
/// slot lock: the list is snapshotted, pruned, and applied with a compare-and-set; after a
/// bounded retry the fallback merges under the lock with a cheap truncation instead.
fn add_reverse_edge(graph: &Graph, nid: u32, new_id: u32, level: u8, cap: usize) {
    if level == 0 {
        for _ in 0..2 {
            let mut snapshot: Vec<u32> = Vec::new();
            if graph.neighbors_into(nid, &mut snapshot).is_none() {
                return;
            }
            if snapshot.contains(&new_id) {
                return;
            }
            let mut next = snapshot.clone();
            next.push(new_id);
            if next.len() > cap {
                prune_with_coverage(graph, nid, &mut next, cap);
            }
            if graph.set_neighbors_if(nid, &snapshot, &next).unwrap_or(false) {
                return;
            }
        }
        // contended twice: merge cheaply under the lock (bounded critical section)
        let _ = graph.update_neighbors(nid, |list| {
            if !list.contains(&new_id) {
                list.push(new_id);
                list.truncate(cap);
            }
        });
    } else {
        let _ = graph.update_upper_level(nid, level, |list| {
            if list.contains(&new_id) {
                return;
            }
            list.push(new_id);
            if list.len() > cap {
                prune_with_coverage(graph, nid, list, cap);
            }
        });
    }
}

/// Insert a vector, returning its node id — or None when the plane is full (max_nodes).
pub fn insert(graph: &Graph, vector: &[f32], params: &InsertParams, scratch: &mut SearchScratch) -> Option<u32> {
    let (bytes, scale, inv_mag) = quantize_int8(vector);
    let id = graph.file.allocate_id();
    if id == NO_ID {
        return None;
    }
    let level = level_for(id, params.ml);
    let query = Query::new(vector.to_vec());
    let layer0_cap = graph.file.layer0_cap;
    let m = params.m;

    let (entry_id, entry_level) = graph.file.entry_point();
    if entry_id == NO_ID {
        let upper_idx = if level > 0 { graph.write_upper(&vec![Vec::new(); level as usize]).unwrap_or(NO_UPPER) } else { NO_UPPER };
        if graph.write_node(id, level, &bytes, scale, inv_mag, &[], upper_idx).is_err() { return None; }
        // CAS: a concurrent first insert may have installed an entry already — never clobber
        graph.file.set_entry_point_if_not_better(id, level as u32, NO_ID);
        return Some(id);
    }

    let mut stats = SearchStats { visits: 0 };
    let (entry_id, entry_level, entry_dist) = match graph.distance_to(entry_id, &query) {
        Some(d) => (entry_id, entry_level, d),
        None => {
            // The stored entry point is gone (e.g. a mirroring host cleared it without
            // re-electing). Self-promoting an edgeless new node here would orphan the whole
            // existing graph behind an unreachable root — re-elect from the live graph and
            // continue; only a truly empty graph makes this node the first entry.
            graph.reelect_entry_point(&[]);
            let (re_id, re_level) = graph.file.entry_point();
            match (re_id != NO_ID).then(|| graph.distance_to(re_id, &query)).flatten() {
                Some(d) => (re_id, re_level, d),
                None => {
                    let upper_idx = if level > 0 { graph.write_upper(&vec![Vec::new(); level as usize]).unwrap_or(NO_UPPER) } else { NO_UPPER };
                    if graph.write_node(id, level, &bytes, scale, inv_mag, &[], upper_idx).is_err() { return None; }
                    graph.file.set_entry_point_if_not_better(id, level as u32, NO_ID);
                    return Some(id);
                }
            }
        }
    };
    let top = level.min(entry_level as u8);
    let (mut ep, mut ep_dist) =
        greedy_descend(graph, &query, entry_id, entry_dist, entry_level, top as u32, &mut stats);

    // Per-level connection lists for the new node, selection-ordered.
    let mut connections: Vec<Vec<(u32, f32)>> = vec![Vec::new(); level as usize + 1];
    let mut nbuf: Vec<u32> = Vec::new();

    for l in (0..=top).rev() {
        scratch_begin(graph, scratch);
        let mut neighbors =
            search_layer(graph, &query, ep, ep_dist, params.ef_construction, l, scratch, &mut stats, None, u64::MAX);
        neighbors.truncate(m << 1);
        if let Some(&(best, best_d)) = neighbors.first() {
            ep = best;
            ep_dist = best_d;
        }

        // JS optimizeRouting selection over rank-ordered candidates.
        let take_conns = std::mem::take(&mut connections[l as usize]);
        let mut conns = take_conns;
        for (i, &(nid, ndist)) in neighbors.iter().enumerate() {
            if nid == id {
                continue;
            }
            let mut skipping = false;
            let mut replaced: Vec<(u32, u32)> = Vec::new(); // (from, to) edge removals
            if params.optimize_routing > 0.0 {
                let distance_threshold = 1.0 + params.optimize_routing * (1.0 + (0.5 * i as f32) / m as f32);
                neighbors_at(graph, nid, l, &mut nbuf);
                for (i2, &nnid) in nbuf.iter().enumerate() {
                    let neighbor_threshold = 1.0 + params.optimize_routing * (1.0 + (0.5 * i2 as f32) / m as f32);
                    if let Some(&(added_id, added_dist)) = conns.iter().find(|(aid, _)| *aid == nnid) {
                        // recompute the stored neighbor↔neighbor distance (not persisted)
                        let neighbor_distance = graph.distance_between(nid, nnid).unwrap_or(f32::INFINITY);
                        if ndist * distance_threshold > added_dist + neighbor_distance {
                            skipping = true;
                            break; // JS: `if (skipping) break` ends the neighbor scan
                        } else if neighbor_distance * neighbor_threshold > ndist + added_dist {
                            replaced.push((added_id, nid));
                            replaced.push((nid, added_id));
                        }
                        // JS breaks only the inner connections scan; keep scanning neighbors
                    }
                }
                if skipping {
                    continue;
                }
            } else if i >= if l > 0 { m } else { m << 1 } {
                continue;
            }
            conns.push((nid, ndist));
            for (from, to) in replaced {
                remove_edge(graph, from, to, l);
            }
        }
        connections[l as usize] = conns;
    }

    // Write the new node: upper entry first so a reader that sees the node sees its
    // hierarchy; layer-0 list pruned to the file cap (selection order = rank order).
    let upper_idx = if level > 0 {
        let levels: Vec<Vec<u32>> = (1..=level as usize)
            .map(|l| {
                connections
                    .get(l)
                    .map(|c| c.iter().map(|&(nid, _)| nid).collect())
                    .unwrap_or_default()
            })
            .collect();
        graph.write_upper(&levels).unwrap_or(NO_UPPER)
    } else {
        NO_UPPER
    };
    let mut l0: Vec<u32> = connections[0].iter().map(|&(nid, _)| nid).collect();
    l0.truncate(layer0_cap);
    if graph.write_node(id, level, &bytes, scale, inv_mag, &l0, upper_idx).is_err() { return None; }

    // Reverse edges.
    for (l, conns) in connections.iter().enumerate() {
        let cap = if l == 0 { layer0_cap } else { m << 1 };
        for &(nid, _) in conns {
            add_reverse_edge(graph, nid, id, l as u8, cap);
        }
    }

    if (level as u32) > entry_level {
        // CAS against the observed entry: a concurrent higher-level promotion wins
        graph.file.set_entry_point_if_not_better(id, level as u32, entry_id);
    }
    Some(id)
}

#[inline]
fn scratch_begin(graph: &Graph, scratch: &mut SearchScratch) {
    // search_layer assumes a fresh epoch per sweep; SearchScratch::begin is crate-private
    // via this helper to keep the public surface small.
    scratch.begin_public(graph.file.id_high_water());
}
