//! Slot-level node access over the plane file, mediated by the seqlock, plus the resident
//! upper-layer structure. Prototype status: upper layers live in memory and are rebuilt at
//! open by scanning slots; the append-allocated file region from the design doc is a TODO.

use crate::format::{PlaneFile, FLAG_DELETED, FLAG_VALID, S_DEGREE, S_FLAGS, S_INV_MAG, S_LEVEL, S_SCALE, S_VECTOR};
use crate::seqlock;
use std::collections::HashMap;
use std::sync::RwLock;

pub struct Graph {
    pub file: PlaneFile,
    /// Upper-layer adjacency: node id -> [neighbors at level 1, level 2, ...]. ~6% of nodes.
    pub upper: RwLock<HashMap<u32, Vec<Vec<u32>>>>,
}

/// A consistent copy of one node's traversal-relevant data.
pub struct NodeRead {
    pub valid: bool,
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

    /// Seqlock-consistent read of a slot. Returns None for never-written or deleted slots.
    pub fn read_node(&self, id: u32) -> Option<NodeRead> {
        if (id as u64) >= self.file.id_high_water() {
            return None;
        }
        let seq = self.file.seq_atomic(id);
        let dims = self.file.dims;
        let cap = self.file.layer0_cap;
        let node = seqlock::read_consistent(seq, || {
            let p = self.file.slot_ptr(id);
            unsafe {
                let flags = *p.add(S_FLAGS);
                if flags & FLAG_VALID == 0 || flags & FLAG_DELETED != 0 {
                    return None;
                }
                let level = *p.add(S_LEVEL);
                let degree = u16::from_le(*(p.add(S_DEGREE) as *const u16)) as usize;
                let scale = f32::from_le_bytes(std::slice::from_raw_parts(p.add(S_SCALE), 4).try_into().unwrap());
                let inv_mag = f32::from_le_bytes(std::slice::from_raw_parts(p.add(S_INV_MAG), 4).try_into().unwrap());
                let vector = std::slice::from_raw_parts(p.add(S_VECTOR) as *const i8, dims).to_vec();
                let nbytes = std::slice::from_raw_parts(p.add(S_VECTOR + dims), degree.min(cap) * 4);
                let neighbors = nbytes.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
                Some(NodeRead { valid: true, level, scale, inv_mag, vector, neighbors })
            }
        });
        node
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
            (p.add(S_DEGREE) as *mut u16).write((neighbors.len() as u16).to_le());
            std::ptr::copy_nonoverlapping(scale.to_le_bytes().as_ptr(), p.add(S_SCALE), 4);
            std::ptr::copy_nonoverlapping(inv_mag.to_le_bytes().as_ptr(), p.add(S_INV_MAG), 4);
            std::ptr::copy_nonoverlapping(vector.as_ptr() as *const u8, p.add(S_VECTOR), dims);
            for (i, n) in neighbors.iter().enumerate() {
                (p.add(S_VECTOR + dims + i * 4) as *mut u32).write(n.to_le());
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
            (p.add(S_DEGREE) as *mut u16).write((neighbors.len() as u16).to_le());
            for (i, n) in neighbors.iter().enumerate() {
                (p.add(S_VECTOR + dims + i * 4) as *mut u32).write(n.to_le());
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
