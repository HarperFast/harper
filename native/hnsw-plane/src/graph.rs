//! Slot-level node access over the plane file, mediated by per-slot seqlocks. Hot-path
//! reads (distance, neighbor ids) are zero-copy against the mmap; full-copy read_node
//! exists for construction paths. Upper-layer adjacency lives in a fixed-entry region of
//! the same file (per-entry seqlocks), so the hierarchy persists with the graph and
//! concurrent searches share nothing mutable.

use crate::distance::{cosine_i8_i8_raw, cosine_int8_raw, Query};
use crate::format::{
    PlaneFile, FLAG_DELETED, FLAG_VALID, MAX_UPPER_LEVELS, NO_UPPER, S_DEGREE, S_FLAGS, S_INV_MAG, S_LEVEL, S_SCALE,
    S_UPPER_IDX, S_VECTOR, UPPER_CAP, UPPER_LEVEL_STRIDE, U_LEVELS, U_LISTS,
};
use crate::seqlock;

pub struct Graph {
    pub file: PlaneFile,
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
        Graph { file }
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
    /// Plain unlocked reads: a torn read only perturbs a construction heuristic.
    pub fn distance_between(&self, a: u32, b: u32) -> Option<f32> {
        if !self.in_range(a) || !self.in_range(b) {
            return None;
        }
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

    /// The node's upper-region entry index, or NO_UPPER.
    #[inline]
    fn upper_idx_of(&self, id: u32) -> u32 {
        if !self.in_range(id) {
            return NO_UPPER;
        }
        let seq = self.file.seq_atomic(id);
        seqlock::read_consistent(seq, || {
            let p = self.file.slot_ptr(id);
            unsafe {
                let flags = *p.add(S_FLAGS);
                if flags & FLAG_VALID == 0 || flags & FLAG_DELETED != 0 {
                    return NO_UPPER;
                }
                (p.add(S_UPPER_IDX) as *const u32).read_unaligned()
            }
        })
    }

    /// Copy `id`'s neighbor ids at upper `level` (1-based) into `out`. False when the node
    /// has no upper entry or no such level.
    pub fn upper_neighbors_into(&self, id: u32, level: u8, out: &mut Vec<u32>) -> bool {
        out.clear();
        debug_assert!(level >= 1);
        let idx = self.upper_idx_of(id);
        if idx == NO_UPPER || level as usize > MAX_UPPER_LEVELS {
            return false;
        }
        let seq = self.file.upper_seq_atomic(idx);
        seqlock::read_consistent(seq, || {
            out.clear();
            let p = self.file.upper_ptr(idx);
            unsafe {
                let levels = *p.add(U_LEVELS);
                if level > levels {
                    return false;
                }
                let lp = p.add(U_LISTS + (level as usize - 1) * UPPER_LEVEL_STRIDE);
                let degree = u16::from_le((lp as *const u16).read_unaligned()) as usize;
                let base = lp.add(2) as *const u32;
                for i in 0..degree.min(UPPER_CAP) {
                    out.push(u32::from_le(base.add(i).read_unaligned()));
                }
                true
            }
        })
    }

    /// Write a node's full upper adjacency into a fresh region entry; returns the entry
    /// index to store in the slot (NO_UPPER when the region is exhausted or levels is empty).
    pub fn write_upper(&self, levels: &[Vec<u32>]) -> u32 {
        if levels.is_empty() {
            return NO_UPPER;
        }
        let idx = self.file.allocate_upper();
        if idx == NO_UPPER {
            return NO_UPPER;
        }
        let seq = self.file.upper_seq_atomic(idx);
        let _guard = seqlock::write_lock(seq);
        let p = self.file.upper_ptr_mut(idx);
        unsafe {
            let n = levels.len().min(MAX_UPPER_LEVELS);
            *p.add(U_LEVELS) = n as u8;
            for (l, list) in levels.iter().take(n).enumerate() {
                let lp = p.add(U_LISTS + l * UPPER_LEVEL_STRIDE);
                let deg = list.len().min(UPPER_CAP);
                (lp as *mut u16).write_unaligned((deg as u16).to_le());
                let base = lp.add(2) as *mut u32;
                for (i, id) in list.iter().take(deg).enumerate() {
                    base.add(i).write_unaligned(id.to_le());
                }
            }
        }
        idx
    }

    /// Atomic read-modify-write of `id`'s upper adjacency at `level` (1-based). Returns
    /// false when the node has no entry or level. `f` may read other slots.
    pub fn update_upper_level<F: FnOnce(&mut Vec<u32>)>(&self, id: u32, level: u8, f: F) -> bool {
        let idx = self.upper_idx_of(id);
        if idx == NO_UPPER || level as usize > MAX_UPPER_LEVELS {
            return false;
        }
        let seq = self.file.upper_seq_atomic(idx);
        let _guard = seqlock::write_lock(seq);
        let p = self.file.upper_ptr_mut(idx);
        unsafe {
            let levels = *p.add(U_LEVELS);
            if level > levels {
                return false;
            }
            let lp = p.add(U_LISTS + (level as usize - 1) * UPPER_LEVEL_STRIDE);
            let degree = u16::from_le((lp as *const u16).read_unaligned()) as usize;
            let base = lp.add(2) as *mut u32;
            let mut list: Vec<u32> = (0..degree.min(UPPER_CAP)).map(|i| u32::from_le(base.add(i).read_unaligned())).collect();
            f(&mut list);
            list.truncate(UPPER_CAP);
            (lp as *mut u16).write_unaligned((list.len() as u16).to_le());
            for (i, id) in list.iter().enumerate() {
                base.add(i).write_unaligned(id.to_le());
            }
        }
        true
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

    /// Write a full slot under its seqlock. `neighbors` is pruned to layer0_cap by the
    /// caller; `upper_idx` is a write_upper() result (NO_UPPER for level-0 nodes).
    pub fn write_node(&self, id: u32, level: u8, vector: &[i8], scale: f32, inv_mag: f32, neighbors: &[u32], upper_idx: u32) {
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
            (p.add(S_UPPER_IDX) as *mut u32).write_unaligned(upper_idx);
            std::ptr::copy_nonoverlapping(vector.as_ptr() as *const u8, p.add(S_VECTOR), dims);
            for (i, n) in neighbors.iter().enumerate() {
                (p.add(S_VECTOR + dims + i * 4) as *mut u32).write_unaligned(n.to_le());
            }
            // valid last within the locked section; the seqlock release publishes it
            *p.add(S_FLAGS) = FLAG_VALID;
        }
    }

    /// Atomic read-modify-write of a node's layer-0 neighbor list under its seqlock.
    /// `f` may read OTHER slots (e.g. distance_between for pruning) — those are plain
    /// unlocked reads, so no lock ordering issue — but must not lock this graph's slots.
    /// Returns false for absent/deleted nodes.
    pub fn update_neighbors<F: FnOnce(&mut Vec<u32>)>(&self, id: u32, f: F) -> bool {
        if !self.in_range(id) {
            return false;
        }
        let seq = self.file.seq_atomic(id);
        let _guard = seqlock::write_lock(seq);
        let p = self.file.slot_ptr_mut(id);
        let dims = self.file.dims;
        let cap = self.file.layer0_cap;
        unsafe {
            let flags = *p.add(S_FLAGS);
            if flags & FLAG_VALID == 0 || flags & FLAG_DELETED != 0 {
                return false;
            }
            let degree = u16::from_le((p.add(S_DEGREE) as *const u16).read_unaligned()) as usize;
            let base = p.add(S_VECTOR + dims) as *mut u32;
            let mut list: Vec<u32> = (0..degree.min(cap)).map(|i| u32::from_le(base.add(i).read_unaligned())).collect();
            f(&mut list);
            list.truncate(cap);
            (p.add(S_DEGREE) as *mut u16).write_unaligned((list.len() as u16).to_le());
            for (i, n) in list.iter().enumerate() {
                base.add(i).write_unaligned(n.to_le());
            }
        }
        true
    }

    /// Replace only the neighbor list (single-writer construction path).
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

    /// Mark deleted (traversals skip it) and return the id to the freelist. The upper-region
    /// entry, if any, is leaked (bounded by the region's 2x-headroom reserve; freelist TODO).
    pub fn delete_node(&self, id: u32) {
        {
            let seq = self.file.seq_atomic(id);
            let _guard = seqlock::write_lock(seq);
            unsafe { *self.file.slot_ptr_mut(id).add(S_FLAGS) = FLAG_DELETED };
        }
        self.file.free_id(id);
    }
}
