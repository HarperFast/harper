//! Slot-level node access over the plane file, mediated by the seqlock, plus the resident
//! upper-layer structure. Hot-path reads (distance, neighbor ids) are zero-copy against the
//! mmap; full-copy read_node exists for construction paths. Prototype status: upper layers
//! live in memory; the append-allocated file region from the design doc is a TODO.

use crate::distance::{cosine_i8_i8_raw, cosine_int8_raw, Query};
use crate::format::{PlaneFile, FLAG_DELETED, FLAG_VALID, S_DEGREE, S_FLAGS, S_INV_MAG, S_LEVEL, S_SCALE, S_VECTOR};
use crate::seqlock;
use std::collections::HashMap;
use std::sync::RwLock;

pub struct Graph {
    pub file: PlaneFile,
    /// Upper-layer adjacency: node id -> [neighbors at level 1, level 2, ...]. ~6% of nodes.
    pub upper: RwLock<HashMap<u32, Vec<Vec<u32>>>>,
}

/// A consistent full copy of one node (construction paths only; search uses zero-copy).
pub struct NodeRead {
    pub level: u8,
    pub scale: f32,
    pub inv_mag: f32,
    pub vector: Vec<i8>,
    pub neighbors: Vec<u32>,
}

impl Graph {
    pub fn new(file: PlaneFile) -> Self {
        Graph { file, upper: RwLock::new(HashMap::new()) }
    }

    #[inline]
    fn in_range(&self, id: u32) -> bool {
        (id as u64) < self.file.id_high_water()
    }

    /// Zero-copy distance from `query` to the stored vector of `id`. None for absent/deleted.
    #[inline]
    pub fn distance_to(&self, id: u32, query: &Query) -> Option<f32> {
        if !self.in_range(id) {
            return None;
        }
        let seq = self.file.seq_atomic(id);
        seqlock::read_consistent(seq, || {
            let p = self.file.slot_ptr(id);
            unsafe {
                let flags = *p.add(S_FLAGS);
                if flags & FLAG_VALID == 0 || flags & FLAG_DELETED != 0 {
                    return None;
                }
                let scale = (p.add(S_SCALE) as *const f32).read_unaligned();
                let inv_mag = (p.add(S_INV_MAG) as *const f32).read_unaligned();
                Some(cosine_int8_raw(query, p.add(S_VECTOR) as *const i8, scale, inv_mag))
            }
        })
    }

    /// Symmetric stored-to-stored distance (construction-time neighbor↔neighbor checks).
    pub fn distance_between(&self, a: u32, b: u32) -> Option<f32> {
        if !self.in_range(a) || !self.in_range(b) {
            return None;
        }
        // Two independent seqlock reads: copy a's params + vector ptr safely by nesting reads.
        // A torn cross-pair read is acceptable here (construction heuristic, not a result).
        let dims = self.file.dims;
        let pa = self.file.slot_ptr(a);
        let pb = self.file.slot_ptr(b);
        unsafe {
            let fa = *pa.add(S_FLAGS);
            let fb = *pb.add(S_FLAGS);
            if fa & FLAG_VALID == 0 || fa & FLAG_DELETED != 0 || fb & FLAG_VALID == 0 || fb & FLAG_DELETED != 0 {
                return None;
            }
            let scale_a = (pa.add(S_SCALE) as *const f32).read_unaligned();
            let inv_a = (pa.add(S_INV_MAG) as *const f32).read_unaligned();
            let scale_b = (pb.add(S_SCALE) as *const f32).read_unaligned();
            let inv_b = (pb.add(S_INV_MAG) as *const f32).read_unaligned();
            Some(cosine_i8_i8_raw(
                pa.add(S_VECTOR) as *const i8,
                scale_a,
                inv_a,
                pb.add(S_VECTOR) as *const i8,
                scale_b,
                inv_b,
                dims,
            ))
        }
    }

    /// Copy layer-0 neighbor ids into `out` (cleared first). Returns the node's level,
    /// or None for absent/deleted.
    #[inline]
    pub fn neighbors_into(&self, id: u32, out: &mut Vec<u32>) -> Option<u8> {
        out.clear();
        if !self.in_range(id) {
            return None;
        }
        let seq = self.file.seq_atomic(id);
        let cap = self.file.layer0_cap;
        let dims = self.file.dims;
        seqlock::read_consistent(seq, || {
            out.clear();
            let p = self.file.slot_ptr(id);
            unsafe {
                let flags = *p.add(S_FLAGS);
                if flags & FLAG_VALID == 0 || flags & FLAG_DELETED != 0 {
                    return None;
                }
                let level = *p.add(S_LEVEL);
                let degree = u16::from_le((p.add(S_DEGREE) as *const u16).read_unaligned()) as usize;
                let base = p.add(S_VECTOR + dims) as *const u32;
                for i in 0..degree.min(cap) {
                    out.push(u32::from_le(base.add(i).read_unaligned()));
                }
                Some(level)
            }
        })
    }

    /// Seqlock-consistent full copy (construction paths).
    pub fn read_node(&self, id: u32) -> Option<NodeRead> {
        if !self.in_range(id) {
            return None;
        }
        let seq = self.file.seq_atomic(id);
        let dims = self.file.dims;
        let cap = self.file.layer0_cap;
        seqlock::read_consistent(seq, || {
            let p = self.file.slot_ptr(id);
            unsafe {
                let flags = *p.add(S_FLAGS);
                if flags & FLAG_VALID == 0 || flags & FLAG_DELETED != 0 {
                    return None;
                }
                let level = *p.add(S_LEVEL);
                let degree = u16::from_le((p.add(S_DEGREE) as *const u16).read_unaligned()) as usize;
                let scale = (p.add(S_SCALE) as *const f32).read_unaligned();
                let inv_mag = (p.add(S_INV_MAG) as *const f32).read_unaligned();
                let vector = std::slice::from_raw_parts(p.add(S_VECTOR) as *const i8, dims).to_vec();
                let nbase = p.add(S_VECTOR + dims) as *const u32;
                let neighbors = (0..degree.min(cap)).map(|i| u32::from_le(nbase.add(i).read_unaligned())).collect();
                Some(NodeRead { level, scale, inv_mag, vector, neighbors })
            }
        })
    }

    /// Write a full slot under its seqlock. `neighbors` is pruned to layer0_cap by the caller.
    pub fn write_node(&self, id: u32, level: u8, vector: &[i8], scale: f32, inv_mag: f32, neighbors: &[u32]) {
        debug_assert!(neighbors.len() <= self.file.layer0_cap);
        debug_assert_eq!(vector.len(), self.file.dims);
        let seq = self.file.seq_atomic(id);
        let _guard = seqlock::write_lock(seq);
        let p = self.file.slot_ptr_mut(id);
        let dims = self.file.dims;
        unsafe {
            *p.add(S_LEVEL) = level;
            (p.add(S_DEGREE) as *mut u16).write_unaligned((neighbors.len() as u16).to_le());
            (p.add(S_SCALE) as *mut f32).write_unaligned(scale);
            (p.add(S_INV_MAG) as *mut f32).write_unaligned(inv_mag);
            std::ptr::copy_nonoverlapping(vector.as_ptr() as *const u8, p.add(S_VECTOR), dims);
            for (i, n) in neighbors.iter().enumerate() {
                (p.add(S_VECTOR + dims + i * 4) as *mut u32).write_unaligned(n.to_le());
            }
            // valid last within the locked section; the seqlock release publishes it
            *p.add(S_FLAGS) = FLAG_VALID;
        }
    }

    /// Replace only the neighbor list (back-edge maintenance path).
    pub fn write_neighbors(&self, id: u32, neighbors: &[u32]) {
        debug_assert!(neighbors.len() <= self.file.layer0_cap);
        let seq = self.file.seq_atomic(id);
        let _guard = seqlock::write_lock(seq);
        let p = self.file.slot_ptr_mut(id);
        let dims = self.file.dims;
        unsafe {
            (p.add(S_DEGREE) as *mut u16).write_unaligned((neighbors.len() as u16).to_le());
            for (i, n) in neighbors.iter().enumerate() {
                (p.add(S_VECTOR + dims + i * 4) as *mut u32).write_unaligned(n.to_le());
            }
        }
    }

    /// Mark deleted (traversals skip it) and return the id to the freelist.
    pub fn delete_node(&self, id: u32) {
        {
            let seq = self.file.seq_atomic(id);
            let _guard = seqlock::write_lock(seq);
            unsafe { *self.file.slot_ptr_mut(id).add(S_FLAGS) = FLAG_DELETED };
        }
        self.upper.write().unwrap().remove(&id);
        self.file.free_id(id);
    }
}
