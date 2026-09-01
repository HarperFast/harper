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
use crate::seqlock::Wedged;

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

    /// Sanitizer for a slot lock taken over from a dead writer: the payload is half-written,
    /// so the slot must read as deleted until something rewrites it (heal-on-touch contract;
    /// FLAG_DELETED rather than 0 so hosts can still free/reuse the id).
    fn slot_sanitizer(&self, id: u32) -> impl Fn() + '_ {
        move || unsafe {
            let p = self.file.slot_ptr_mut(id);
            // a dead writer's slot may hold a garbage (or zero-initialized) upper index; a
            // later raw rewrite would reuse it and clobber another node's hierarchy
            (p.add(S_UPPER_IDX) as *mut u32).write_unaligned(NO_UPPER);
            *p.add(S_FLAGS) = FLAG_DELETED;
        }
    }

    fn owner_dead(&self) -> impl Fn(u32) -> bool + '_ {
        move |tag| self.file.tag_is_dead(tag)
    }

    /// Sanitizer for an upper-entry lock taken over from a dead writer.
    fn upper_sanitizer(&self, idx: u32) -> impl Fn() + '_ {
        move || unsafe { *self.file.upper_ptr_mut(idx).add(U_LEVELS) = 0 }
    }

    /// Zero-copy distance from `query` to the stored vector of `id`. None for absent/deleted.
    #[inline]
    pub fn distance_to(&self, id: u32, query: &Query) -> Option<f32> {
        if !self.in_range(id) {
            return None;
        }
        let seq = self.file.seq_atomic(id);
        seqlock::read_consistent(seq, self.file.self_tag, || {
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
        }, self.slot_sanitizer(id), || None, self.owner_dead())
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
        seqlock::read_consistent(seq, self.file.self_tag, || {
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
        }, self.slot_sanitizer(id), || None, self.owner_dead())
    }

    /// The node's upper-region entry index, or NO_UPPER.
    #[inline]
    fn upper_idx_of(&self, id: u32) -> u32 {
        if !self.in_range(id) {
            return NO_UPPER;
        }
        let seq = self.file.seq_atomic(id);
        seqlock::read_consistent(seq, self.file.self_tag, || {
            let p = self.file.slot_ptr(id);
            unsafe {
                let flags = *p.add(S_FLAGS);
                if flags & FLAG_VALID == 0 || flags & FLAG_DELETED != 0 {
                    return NO_UPPER;
                }
                (p.add(S_UPPER_IDX) as *const u32).read_unaligned()
            }
        }, self.slot_sanitizer(id), || NO_UPPER, self.owner_dead())
    }

    /// Copy `id`'s neighbor ids at upper `level` (1-based) into `out`. False when the node
    /// has no upper entry or no such level.
    pub fn upper_neighbors_into(&self, id: u32, level: u8, out: &mut Vec<u32>) -> bool {
        out.clear();
        debug_assert!(level >= 1);
        let idx = self.upper_idx_of(id);
        if idx == NO_UPPER || (idx as u64) >= self.file.upper_capacity || level as usize > MAX_UPPER_LEVELS {
            return false;
        }
        let seq = self.file.upper_seq_atomic(idx);
        seqlock::read_consistent(seq, self.file.self_tag, || {
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
        }, self.upper_sanitizer(idx), || false, self.owner_dead())
    }

    /// Write a node's full upper adjacency into a fresh region entry; returns the entry
    /// index to store in the slot (NO_UPPER when the region is exhausted or levels is empty).
    pub fn write_upper(&self, levels: &[Vec<u32>]) -> Result<u32, Wedged> {
        if levels.is_empty() {
            return Ok(NO_UPPER);
        }
        let idx = self.file.allocate_upper();
        if idx == NO_UPPER {
            return Ok(NO_UPPER);
        }
        let seq = self.file.upper_seq_atomic(idx);
        let _guard = seqlock::write_lock(seq, self.file.self_tag, self.upper_sanitizer(idx), self.owner_dead())?;
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
        Ok(idx)
    }

    /// Rewrite an existing upper entry in place (full state). Used by the raw mirroring
    /// path so repeated updates to a high-level node reuse its entry instead of leaking one
    /// per rewrite.
    pub fn rewrite_upper(&self, idx: u32, levels: &[Vec<u32>]) -> Result<(), Wedged> {
        let seq = self.file.upper_seq_atomic(idx);
        let _guard = seqlock::write_lock(seq, self.file.self_tag, self.upper_sanitizer(idx), self.owner_dead())?;
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
        Ok(())
    }

    /// Whether a slot has ever been written (valid or deleted) — the builder scan's
    /// skip-if-touched check.
    pub fn node_touched(&self, id: u32) -> bool {
        if !self.in_range(id) {
            return false;
        }
        let seq = self.file.seq_atomic(id);
        seqlock::read_consistent(seq, self.file.self_tag, || unsafe { *self.file.slot_ptr(id).add(S_FLAGS) != 0 }, self.slot_sanitizer(id), || true, self.owner_dead())
    }

    /// The slot's stored upper idx regardless of valid/deleted flags. Taken under the slot
    /// write lock rather than `read_consistent`, whose NO_UPPER fallback cannot be told apart
    /// from an unbound slot — reusing it as one mints a second entry for an id that already
    /// owns one.
    fn upper_idx_locked(&self, id: u32) -> Result<u32, Wedged> {
        if !self.in_range(id) {
            return Ok(NO_UPPER);
        }
        let seq = self.file.seq_atomic(id);
        let _guard = seqlock::write_lock(seq, self.file.self_tag, self.slot_sanitizer(id), self.owner_dead())?;
        let p = self.file.slot_ptr(id);
        Ok(unsafe {
            if *p.add(S_FLAGS) == 0 {
                NO_UPPER // never written
            } else {
                (p.add(S_UPPER_IDX) as *const u32).read_unaligned()
            }
        })
    }

    /// Mirror a host-maintained node into the plane: full state per call, host-allocated id
    /// (high-water is raised, the plane allocator is bypassed), upper entry reused in place
    /// when present. This is the dual-write phase-1 write path.
    pub fn write_node_raw(
        &self,
        id: u32,
        level: u8,
        vector: &[i8],
        scale: f32,
        inv_mag: f32,
        neighbors: &[u32],
        upper_levels: &[Vec<u32>],
    ) -> Result<(), Wedged> {
        self.file.ensure_high_water(id);
        let existing = match self.upper_idx_locked(id)? {
            idx if idx != NO_UPPER && (idx as u64) >= self.file.upper_capacity => NO_UPPER, // corrupt stored index
            idx => idx,
        };
        let mut fresh = NO_UPPER;
        let upper_idx = if upper_levels.is_empty() {
            // the host reseeds its id counter to largestNodeId + 1 on restart, so an id can be
            // re-minted at level 0 over a slot that had a hierarchy; that entry must stop being
            // readable. Emptied in place rather than freed: the freelist hand-off is not atomic
            // with publishing the slot below, so a mirror that read this index first could
            // republish a slot pointing at an entry already given to another node. One idle
            // entry per id is the bounded retention hnsw-native-plane.md §10 accepts.
            if existing != NO_UPPER {
                self.rewrite_upper(existing, &[])?;
            }
            existing
        } else if existing != NO_UPPER {
            self.rewrite_upper(existing, upper_levels)?;
            existing
        } else {
            fresh = self.write_upper(upper_levels)?;
            fresh
        };
        let mut l0 = neighbors.to_vec();
        l0.truncate(self.file.layer0_cap);
        if let Err(wedged) = self.write_node(id, level, vector, scale, inv_mag, &l0, upper_idx) {
            self.file.free_upper(fresh); // unreachable from any slot until publication succeeds
            return Err(wedged);
        }
        Ok(())
    }

    /// Mark deleted WITHOUT returning the id to the plane freelist — dual-write mode, where
    /// the host owns id allocation and may re-mint or reuse ids on its own schedule.
    pub fn clear_node(&self, id: u32) -> Result<(), Wedged> {
        if (id as u64) >= self.file.max_nodes {
            return Ok(());
        }
        // extend the high-water rather than skipping: a delete mirrored while a backfill
        // scan runs must leave a touched (deleted) slot behind, or the scan's older
        // snapshot would resurrect the node when its cursor reaches this id
        self.file.ensure_high_water(id);
        let seq = self.file.seq_atomic(id);
        let _guard = seqlock::write_lock(seq, self.file.self_tag, self.slot_sanitizer(id), self.owner_dead())?;
        let p = self.file.slot_ptr_mut(id);
        unsafe {
            if *p.add(S_FLAGS) == 0 {
                // tombstoning a never-written slot: its zero-initialized upper_idx would
                // otherwise read as the VALID index 0, and a later raw rewrite of this id
                // would clobber upper entry 0 — another node's hierarchy
                (p.add(S_UPPER_IDX) as *mut u32).write_unaligned(NO_UPPER);
            }
            *p.add(S_FLAGS) = FLAG_DELETED;
        }
        Ok(())
    }

    /// Atomic read-modify-write of `id`'s upper adjacency at `level` (1-based). Returns
    /// false when the node has no entry or level. `f` may read other slots.
    pub fn update_upper_level<F: FnOnce(&mut Vec<u32>)>(&self, id: u32, level: u8, f: F) -> Result<bool, Wedged> {
        let idx = self.upper_idx_of(id);
        if idx == NO_UPPER || (idx as u64) >= self.file.upper_capacity || level as usize > MAX_UPPER_LEVELS {
            return Ok(false);
        }
        let seq = self.file.upper_seq_atomic(idx);
        let _guard = seqlock::write_lock(seq, self.file.self_tag, self.upper_sanitizer(idx), self.owner_dead())?;
        let p = self.file.upper_ptr_mut(idx);
        unsafe {
            let levels = *p.add(U_LEVELS);
            if level > levels {
                return Ok(false);
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
        Ok(true)
    }

    /// Seqlock-consistent full copy (construction paths).
    pub fn read_node(&self, id: u32) -> Option<NodeRead> {
        if !self.in_range(id) {
            return None;
        }
        let seq = self.file.seq_atomic(id);
        let dims = self.file.dims;
        let cap = self.file.layer0_cap;
        seqlock::read_consistent(seq, self.file.self_tag, || {
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
        }, self.slot_sanitizer(id), || None, self.owner_dead())
    }

    /// Write a full slot under its seqlock. `neighbors` is pruned to layer0_cap by the
    /// caller; `upper_idx` is a write_upper() result (NO_UPPER for level-0 nodes).
    pub fn write_node(&self, id: u32, level: u8, vector: &[i8], scale: f32, inv_mag: f32, neighbors: &[u32], upper_idx: u32) -> Result<(), Wedged> {
        debug_assert!(neighbors.len() <= self.file.layer0_cap);
        debug_assert_eq!(vector.len(), self.file.dims);
        let seq = self.file.seq_atomic(id);
        let _guard = seqlock::write_lock(seq, self.file.self_tag, self.slot_sanitizer(id), self.owner_dead())?;
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
        Ok(())
    }

    /// Atomic read-modify-write of a node's layer-0 neighbor list under its seqlock.
    /// `f` may read OTHER slots (e.g. distance_between for pruning) — those are plain
    /// unlocked reads, so no lock ordering issue — but must not lock this graph's slots.
    /// Returns false for absent/deleted nodes.
    pub fn update_neighbors<F: FnOnce(&mut Vec<u32>)>(&self, id: u32, f: F) -> Result<bool, Wedged> {
        if !self.in_range(id) {
            return Ok(false);
        }
        let seq = self.file.seq_atomic(id);
        let _guard = seqlock::write_lock(seq, self.file.self_tag, self.slot_sanitizer(id), self.owner_dead())?;
        let p = self.file.slot_ptr_mut(id);
        let dims = self.file.dims;
        let cap = self.file.layer0_cap;
        unsafe {
            let flags = *p.add(S_FLAGS);
            if flags & FLAG_VALID == 0 || flags & FLAG_DELETED != 0 {
                return Ok(false);
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
        Ok(true)
    }

    /// Apply a precomputed neighbor list only if the current list still equals `expected` —
    /// the compare and the write share one lock acquisition, so heavy work (distance-based
    /// pruning, which can major-fault) happens OUTSIDE the lock and the critical section
    /// stays microseconds. Returns false when the list changed or the node is gone.
    pub fn set_neighbors_if(&self, id: u32, expected: &[u32], next: &[u32]) -> Result<bool, Wedged> {
        debug_assert!(next.len() <= self.file.layer0_cap);
        if !self.in_range(id) {
            return Ok(false);
        }
        let seq = self.file.seq_atomic(id);
        let _guard = seqlock::write_lock(seq, self.file.self_tag, self.slot_sanitizer(id), self.owner_dead())?;
        let p = self.file.slot_ptr_mut(id);
        let dims = self.file.dims;
        unsafe {
            if *p.add(S_FLAGS) != FLAG_VALID {
                return Ok(false);
            }
            let degree = u16::from_le((p.add(S_DEGREE) as *const u16).read_unaligned()) as usize;
            if degree != expected.len() {
                return Ok(false);
            }
            let base = p.add(S_VECTOR + dims) as *mut u32;
            for (i, want) in expected.iter().enumerate() {
                if u32::from_le(base.add(i).read_unaligned()) != *want {
                    return Ok(false);
                }
            }
            (p.add(S_DEGREE) as *mut u16).write_unaligned((next.len() as u16).to_le());
            for (i, n) in next.iter().enumerate() {
                base.add(i).write_unaligned(n.to_le());
            }
        }
        Ok(true)
    }

    /// Replace only the neighbor list (single-writer construction path).
    pub fn write_neighbors(&self, id: u32, neighbors: &[u32]) -> Result<(), Wedged> {
        debug_assert!(neighbors.len() <= self.file.layer0_cap);
        let seq = self.file.seq_atomic(id);
        let _guard = seqlock::write_lock(seq, self.file.self_tag, self.slot_sanitizer(id), self.owner_dead())?;
        let p = self.file.slot_ptr_mut(id);
        let dims = self.file.dims;
        unsafe {
            (p.add(S_DEGREE) as *mut u16).write_unaligned((neighbors.len() as u16).to_le());
            for (i, n) in neighbors.iter().enumerate() {
                (p.add(S_VECTOR + dims + i * 4) as *mut u32).write_unaligned(n.to_le());
            }
        }
        Ok(())
    }

    /// Mark deleted (traversals skip it), free its upper entry, and return the id to the
    /// plane freelist. Deleting the current entry point re-elects a replacement — without
    /// that, every search returns empty and every insert orphans itself against the dead
    /// entry.
    pub fn delete_node(&self, id: u32) -> Result<(), Wedged> {
        if !self.in_range(id) {
            return Ok(()); // never-allocated or out-of-range ids have nothing to delete
        }
        // capture neighbors before invalidating: they are the best re-election candidates
        let (entry_id, _) = self.file.entry_point();
        let mut candidates: Vec<u32> = Vec::new();
        if entry_id == id {
            self.neighbors_into(id, &mut candidates);
        }
        let upper_idx;
        {
            let seq = self.file.seq_atomic(id);
            let _guard = seqlock::write_lock(seq, self.file.self_tag, self.slot_sanitizer(id), self.owner_dead())?;
            let p = self.file.slot_ptr_mut(id);
            unsafe {
                if *p.add(S_FLAGS) != FLAG_VALID {
                    // deleting a never-written or already-deleted id must not free again:
                    // a double-push makes the freelist a self-cycle that hands the same id
                    // to every subsequent allocation
                    return Ok(());
                }
                upper_idx = (p.add(S_UPPER_IDX) as *const u32).read_unaligned();
                (p.add(S_UPPER_IDX) as *mut u32).write_unaligned(NO_UPPER);
                *p.add(S_FLAGS) = FLAG_DELETED;
            }
        }
        if upper_idx != NO_UPPER && (upper_idx as u64) < self.file.upper_capacity {
            // empty the entry under its own lock BEFORE freeing: a traversal that already
            // read this node's upper_idx must find a dead entry, not one reallocated to a
            // different node mid-read
            self.rewrite_upper(upper_idx, &[])?;
        }
        self.file.free_upper(upper_idx);
        if entry_id == id {
            self.reelect_entry_point_replacing(&candidates, id);
        }
        self.file.free_id(id);
        Ok(())
    }

    /// Pick a new entry point: the highest-level live node among `preferred`, else the
    /// first live node found scanning the id range (rare path: only when the entry's whole
    /// neighborhood is gone). An empty graph clears the entry.
    /// A node's level without copying its vector or edges (cheap re-election scans).
    fn node_level(&self, id: u32) -> Option<u8> {
        if !self.in_range(id) {
            return None;
        }
        let seq = self.file.seq_atomic(id);
        seqlock::read_consistent(seq, self.file.self_tag, || {
            let p = self.file.slot_ptr(id);
            unsafe {
                if *p.add(S_FLAGS) != FLAG_VALID {
                    return None;
                }
                Some(*p.add(S_LEVEL))
            }
        }, self.slot_sanitizer(id), || None, self.owner_dead())
    }

    /// Pick a new entry point: the highest-level live node among `preferred`, else the
    /// highest-level live node found scanning the id range (level reads only — no per-node
    /// vector copies; still O(high-water), which only runs when an entry point vanished
    /// with no live neighborhood). Preferring level keeps the hierarchy navigable — a
    /// level-0 entry degrades every search to a layer-0-only beam. An empty graph clears
    /// the entry.
    pub(crate) fn reelect_entry_point(&self, preferred: &[u32]) {
        self.reelect_entry_point_replacing(preferred, crate::format::NO_ID)
    }

    fn reelect_entry_point_replacing(&self, preferred: &[u32], replacing: u32) {
        let mut best: Option<(u32, u8)> = None;
        // the most recently replaced entry point is the best cheap candidate: usually alive,
        // usually high-level — and it makes the full fallback scan a last resort
        let prev = self.file.previous_entry_point();
        if prev != crate::format::NO_ID && prev != replacing {
            if let Some(level) = self.node_level(prev) {
                best = Some((prev, level));
            }
        }
        for &cand in preferred {
            if let Some(level) = self.node_level(cand) {
                if best.map(|(_, l)| level > l).unwrap_or(true) {
                    best = Some((cand, level));
                }
            }
        }
        if best.is_none() {
            let hw = self.file.id_high_water().min(self.file.max_nodes) as u32;
            for cand in 0..hw {
                if let Some(level) = self.node_level(cand) {
                    if best.map(|(_, l)| level > l).unwrap_or(true) {
                        best = Some((cand, level));
                        if level as usize >= MAX_UPPER_LEVELS {
                            break; // cannot do better
                        }
                    }
                }
            }
        }
        match best {
            Some((cand, level)) => self.file.set_entry_point_if_not_better(cand, level as u32, replacing),
            None => self.file.set_entry_point_if_not_better(crate::format::NO_ID, 0, replacing),
        }
    }

    /// write_node, but only when the slot has never been touched — the check and the write
    /// share ONE seqlock acquisition, so a concurrent live mirror's newer write can never be
    /// overwritten by a backfill scan's older snapshot (a two-step check-then-write left
    /// exactly that window). Returns true when this state was written.
    #[allow(clippy::too_many_arguments)]
    pub fn write_node_if_untouched(
        &self,
        id: u32,
        level: u8,
        vector: &[i8],
        scale: f32,
        inv_mag: f32,
        neighbors: &[u32],
        upper_levels: &[Vec<u32>],
    ) -> Result<bool, Wedged> {
        debug_assert!(neighbors.len() <= self.file.layer0_cap);
        debug_assert_eq!(vector.len(), self.file.dims);
        self.file.ensure_high_water(id);
        // the upper entry is allocated before taking the slot lock (allocation is cheap); it is
        // unreachable from any slot until the write below lands, so every path that does not
        // publish it — a wedged lock, a slot that turns out to be touched — has to free it
        let upper_idx = if upper_levels.is_empty() { NO_UPPER } else { self.write_upper(upper_levels)? };
        let seq = self.file.seq_atomic(id);
        let written = {
            let _guard = match seqlock::write_lock(seq, self.file.self_tag, self.slot_sanitizer(id), self.owner_dead())
            {
                Ok(guard) => guard,
                Err(wedged) => {
                    self.file.free_upper(upper_idx);
                    return Err(wedged);
                }
            };
            let p = self.file.slot_ptr_mut(id);
            let dims = self.file.dims;
            unsafe {
                if *p.add(S_FLAGS) != 0 {
                    false
                } else {
                    *p.add(S_LEVEL) = level;
                    (p.add(S_DEGREE) as *mut u16).write_unaligned((neighbors.len() as u16).to_le());
                    (p.add(S_SCALE) as *mut f32).write_unaligned(scale);
                    (p.add(S_INV_MAG) as *mut f32).write_unaligned(inv_mag);
                    (p.add(S_UPPER_IDX) as *mut u32).write_unaligned(upper_idx);
                    std::ptr::copy_nonoverlapping(vector.as_ptr() as *const u8, p.add(S_VECTOR), dims);
                    for (i, n) in neighbors.iter().enumerate() {
                        (p.add(S_VECTOR + dims + i * 4) as *mut u32).write_unaligned(n.to_le());
                    }
                    *p.add(S_FLAGS) = FLAG_VALID;
                    true
                }
            }
        };
        if !written {
            self.file.free_upper(upper_idx);
        }
        Ok(written)
    }
}
