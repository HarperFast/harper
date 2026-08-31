//! On-disk format: 4 KB header + fixed-size layer-0 slot array + upper-layer region.
//! See ../../../hnsw-native-plane.md §4. Format changes bump VERSION and require reindex.

use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

pub const MAGIC: u32 = 0x484e_5357; // "HNSW"
pub const VERSION: u32 = 3; // v3: packed entry point, UPPER_CAP 64 (older files: reindex)
pub const HEADER_SIZE: usize = 4096;

// Header field byte offsets.
const H_MAGIC: usize = 0;
const H_VERSION: usize = 4;
const H_DIMS: usize = 8; // u16
const H_QUANT: usize = 10; // u8: 0 = int8, 1 = f32
const H_LAYER0_CAP: usize = 12; // u16
const H_SLOT_SIZE: usize = 16; // u32
const H_ENTRY: usize = 24; // u64 atomic: (level << 32) | id, one word so readers never see a torn pair
const H_ID_HIGH_WATER: usize = 32; // u64 atomic
const H_FREELIST_HEAD: usize = 40; // u64 atomic: (tag << 32) | id; id u32::MAX = empty
const H_TXN_WATERMARK: usize = 48; // u64
const H_CLEAN_SHUTDOWN: usize = 56; // u8
const H_MAX_NODES: usize = 64; // u64
const H_UPPER_HIGH_WATER: usize = 72; // u64 atomic: upper-entry allocator
const H_UPPER_FREELIST: usize = 80; // u64 atomic: (tag<<32)|idx; NO_UPPER = empty

/// Upper-layer region geometry: fixed entries covering levels 1..=MAX_UPPER_LEVELS at
/// UPPER_CAP ids per level. P(level >= 1) = 1/M ~ 6.25%; the region reserves entries for
/// 1/8 of max_nodes (2x headroom). P(level >= 9) at mL = 1/ln16 is ~e^-25 — unreachable.
pub const MAX_UPPER_LEVELS: usize = 8;
pub const UPPER_CAP: usize = 64; // matches the JS graph's upper cap (M<<2 under optimizeRouting)
// entry: seq u32 | levels u8 | pad | per-level (degree u16 + ids u32*UPPER_CAP)
pub const U_SEQ: usize = 0;
pub const U_LEVELS: usize = 4;
pub const U_LISTS: usize = 8;
pub const UPPER_LEVEL_STRIDE: usize = 2 + UPPER_CAP * 4 + 2; // degree + ids + pad -> 132
pub const NO_UPPER: u32 = u32::MAX;

// Slot layout offsets (within a slot).
pub const S_SEQ: usize = 0; // u32 seqlock
pub const S_FLAGS: usize = 4; // u8: bit0 = valid, bit1 = deleted
pub const S_LEVEL: usize = 5; // u8
pub const S_DEGREE: usize = 6; // u16
pub const S_SCALE: usize = 8; // f32
pub const S_INV_MAG: usize = 12; // f32
pub const S_UPPER_IDX: usize = 16; // u32 index into the upper region; NO_UPPER = none
pub const S_VECTOR: usize = 20; // dims bytes (int8) or dims*4 (f32)
                                // neighbors: u32 * layer0_cap, follows vector
                                // deleted slots reuse the first neighbor word as freelist next-pointer

pub const FLAG_VALID: u8 = 1;
pub const FLAG_DELETED: u8 = 2;
pub const NO_ID: u32 = u32::MAX;

pub struct PlaneFile {
    pub map: MmapMut,
    pub dims: usize,
    pub layer0_cap: usize,
    pub slot_size: usize,
    pub max_nodes: u64,
    upper_offset: usize,
    pub upper_capacity: u64,
    /// Whether the file recorded a clean shutdown when opened (create() reports true).
    /// An unclean open has had its torn seqlocks scrubbed, but individual slots may hold
    /// unflushed/partial states — hosts should rebuild rather than trust completeness.
    pub opened_clean: bool,
    /// Slots per 4 KB page under page-grouped addressing; 0 = packed (slots may straddle
    /// pages). Grouped is chosen at create when the per-page waste is small (e.g. 1,344 B
    /// slots: 3/page, 64 B waste). Straddling only costs on cold faults, but the layout is
    /// header-pinned so it must be decided before any data exists.
    pub slots_per_page: usize,
}

const PAGE: usize = 4096;
const H_SLOTS_PER_PAGE: usize = 20; // u16

fn slot_size_for(dims: usize, layer0_cap: usize) -> usize {
    let raw = S_VECTOR + dims + layer0_cap * 4;
    raw.next_multiple_of(64) // cache-line align
}

fn upper_entry_size() -> usize {
    (U_LISTS + MAX_UPPER_LEVELS * UPPER_LEVEL_STRIDE).next_multiple_of(64)
}

fn slot_region_len(max_nodes: u64, slot_size: usize, slots_per_page: usize) -> u64 {
    if slots_per_page > 0 {
        max_nodes.div_ceil(slots_per_page as u64) * PAGE as u64
    } else {
        max_nodes * slot_size as u64
    }
}

fn slots_per_page_for(slot_size: usize) -> usize {
    if slot_size > PAGE {
        return 0;
    }
    let per = PAGE / slot_size;
    let waste = PAGE - per * slot_size;
    // group when waste is under ~3% of the page; otherwise pack
    if waste <= 128 { per } else { 0 }
}

impl PlaneFile {
    /// Create a new plane file with capacity for `max_nodes` (sparse; pages materialize on write).
    pub fn create(path: &Path, dims: usize, layer0_cap: usize, max_nodes: u64) -> io::Result<Self> {
        let slot_size = slot_size_for(dims, layer0_cap);
        let slots_per_page = slots_per_page_for(slot_size);
        let data_len = slot_region_len(max_nodes, slot_size, slots_per_page);
        let upper_capacity = max_nodes / 8 + 64;
        let len = HEADER_SIZE as u64 + data_len + upper_capacity * upper_entry_size() as u64;
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(path)?;
        file.set_len(len)?;
        let mut map = unsafe { MmapMut::map_mut(&file)? };
        // geometry and allocator state first; MAGIC+VERSION last, so a concurrent opener
        // in the create window sees an invalid header (retryable) rather than adopting a
        // half-initialized plane with max_nodes = 0
        map[H_DIMS..H_DIMS + 2].copy_from_slice(&(dims as u16).to_le_bytes());
        map[H_QUANT] = 0;
        map[H_LAYER0_CAP..H_LAYER0_CAP + 2].copy_from_slice(&(layer0_cap as u16).to_le_bytes());
        map[H_SLOT_SIZE..H_SLOT_SIZE + 4].copy_from_slice(&(slot_size as u32).to_le_bytes());
        map[H_SLOTS_PER_PAGE..H_SLOTS_PER_PAGE + 2].copy_from_slice(&(slots_per_page as u16).to_le_bytes());
        map[H_ENTRY..H_ENTRY + 8].copy_from_slice(&(NO_ID as u64).to_le_bytes());
        map[H_FREELIST_HEAD..H_FREELIST_HEAD + 8]
            .copy_from_slice(&((NO_ID as u64) | 0u64 << 32).to_le_bytes());
        map[H_MAX_NODES..H_MAX_NODES + 8].copy_from_slice(&max_nodes.to_le_bytes());
        map[H_UPPER_FREELIST..H_UPPER_FREELIST + 8].copy_from_slice(&(NO_UPPER as u64).to_le_bytes());
        map[H_VERSION..H_VERSION + 4].copy_from_slice(&VERSION.to_le_bytes());
        std::sync::atomic::fence(Ordering::Release);
        map[H_MAGIC..H_MAGIC + 4].copy_from_slice(&MAGIC.to_le_bytes());
        let upper_offset = HEADER_SIZE + slot_region_len(max_nodes, slot_size, slots_per_page) as usize;
        Ok(PlaneFile { map, dims, layer0_cap, slot_size, max_nodes, upper_offset, upper_capacity, slots_per_page, opened_clean: true })
    }

    pub fn open(path: &Path) -> io::Result<Self> {
        let file = OpenOptions::new().read(true).write(true).open(path)?;
        let file_len = file.metadata()?.len();
        if file_len < HEADER_SIZE as u64 {
            // a truncated or interrupted create must be a catchable error, not a slice panic
            return Err(io::Error::new(io::ErrorKind::InvalidData, "plane file shorter than its header: recreate the index"));
        }
        let map = unsafe { MmapMut::map_mut(&file)? };
        let magic = u32::from_le_bytes(map[H_MAGIC..H_MAGIC + 4].try_into().unwrap());
        let version = u32::from_le_bytes(map[H_VERSION..H_VERSION + 4].try_into().unwrap());
        if magic != MAGIC || version != VERSION {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "format mismatch: reindex required"));
        }
        let dims = u16::from_le_bytes(map[H_DIMS..H_DIMS + 2].try_into().unwrap()) as usize;
        let layer0_cap = u16::from_le_bytes(map[H_LAYER0_CAP..H_LAYER0_CAP + 2].try_into().unwrap()) as usize;
        let slot_size = u32::from_le_bytes(map[H_SLOT_SIZE..H_SLOT_SIZE + 4].try_into().unwrap()) as usize;
        let slots_per_page = u16::from_le_bytes(map[H_SLOTS_PER_PAGE..H_SLOTS_PER_PAGE + 2].try_into().unwrap()) as usize;
        let max_nodes = u64::from_le_bytes(map[H_MAX_NODES..H_MAX_NODES + 8].try_into().unwrap());
        if dims == 0 || slot_size == 0 || slot_size != slot_size_for(dims, layer0_cap) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "plane header geometry is inconsistent: recreate the index"));
        }
        let upper_offset = HEADER_SIZE + slot_region_len(max_nodes, slot_size, slots_per_page) as usize;
        let upper_capacity = max_nodes / 8 + 64;
        let expected = upper_offset as u64 + upper_capacity * upper_entry_size() as u64;
        if file_len < expected {
            // header-valid but short (rsync/backup truncation): mid-range slot_ptr/upper_ptr
            // would otherwise read off the mapping
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("plane file is {file_len} bytes but its header implies {expected}: recreate the index"),
            ));
        }
        let opened_clean = map[H_CLEAN_SHUTDOWN] == 1;
        let plane = PlaneFile { map, dims, layer0_cap, slot_size, max_nodes, upper_offset, upper_capacity, slots_per_page, opened_clean };
        let hw = plane.id_high_water();
        if hw > max_nodes {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "plane header id high-water exceeds capacity: recreate the index"));
        }
        // A crash while a writer held a slot's seqlock odd persists the odd value; nothing
        // would ever make it even again, so readers and writers of that slot would spin
        // forever. Scrub on any unclean open (one sequential pass over the written range).
        if !opened_clean {
            plane.scrub_torn_seqlocks(hw);
        }
        unsafe { *(plane.map.as_ptr().add(H_CLEAN_SHUTDOWN) as *mut u8) = 0 }; // dirty until flush
        Ok(plane)
    }

    /// Force any persisted-odd seqlocks (slot + upper regions) back to even after an unclean
    /// shutdown. Safe because open() runs before any concurrent access exists.
    fn scrub_torn_seqlocks(&self, high_water: u64) {
        for id in 0..high_water.min(self.max_nodes) as u32 {
            let seq = self.seq_atomic(id);
            let v = seq.load(Ordering::Relaxed);
            if v & 1 == 1 {
                seq.store(v.wrapping_add(1), Ordering::Relaxed);
            }
        }
        let upper_hw = self.header_atomic_u64(H_UPPER_HIGH_WATER).load(Ordering::Relaxed);
        for idx in 0..upper_hw.min(self.upper_capacity) as u32 {
            let seq = self.upper_seq_atomic(idx);
            let v = seq.load(Ordering::Relaxed);
            if v & 1 == 1 {
                seq.store(v.wrapping_add(1), Ordering::Relaxed);
            }
        }
    }

    #[inline]
    pub fn slot_ptr(&self, id: u32) -> *const u8 {
        let off = if self.slots_per_page > 0 {
            (id as usize / self.slots_per_page) * PAGE + (id as usize % self.slots_per_page) * self.slot_size
        } else {
            id as usize * self.slot_size
        };
        unsafe { self.map.as_ptr().add(HEADER_SIZE + off) }
    }

    #[inline]
    pub fn slot_ptr_mut(&self, id: u32) -> *mut u8 {
        // Mutation through a shared map: all mutable slot access is mediated by the seqlock
        // (seqlock.rs) and atomics; the mmap itself is plain memory.
        self.slot_ptr(id) as *mut u8
    }

    #[inline]
    fn header_atomic_u64(&self, offset: usize) -> &AtomicU64 {
        unsafe { &*(self.map.as_ptr().add(offset) as *const AtomicU64) }
    }

    #[inline]
    pub fn seq_atomic(&self, id: u32) -> &AtomicU32 {
        unsafe { &*(self.slot_ptr(id).add(S_SEQ) as *const AtomicU32) }
    }

    /// Allocate a node id: pop the freelist, else bump the high-water. Returns NO_ID when
    /// the plane is full (max_nodes reached) — an unchecked bump would address into the
    /// upper-layer region and, past that, off the mapping.
    pub fn allocate_id(&self) -> u32 {
        let head = self.header_atomic_u64(H_FREELIST_HEAD);
        loop {
            let cur = head.load(Ordering::Acquire);
            let id = (cur & 0xffff_ffff) as u32;
            if id == NO_ID {
                let hw = self.header_atomic_u64(H_ID_HIGH_WATER);
                let new = hw.fetch_add(1, Ordering::AcqRel);
                if new >= self.max_nodes {
                    hw.fetch_sub(1, Ordering::AcqRel);
                    return NO_ID;
                }
                return new as u32;
            }
            // next-pointer lives in the dead slot's first neighbor word
            let next = unsafe {
                (*(self.slot_ptr(id).add(S_VECTOR + self.dims) as *const AtomicU32)).load(Ordering::Acquire)
            };
            let tag = (cur >> 32).wrapping_add(1);
            let new = (next as u64) | (tag << 32);
            if head.compare_exchange(cur, new, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                return id;
            }
        }
    }

    /// Return a deleted node's id to the freelist. Caller must have already marked the slot
    /// deleted (under its seqlock) so concurrent traversals skip it.
    pub fn free_id(&self, id: u32) {
        let head = self.header_atomic_u64(H_FREELIST_HEAD);
        let next_word = unsafe { &*(self.slot_ptr(id).add(S_VECTOR + self.dims) as *const AtomicU32) };
        loop {
            let cur = head.load(Ordering::Acquire);
            next_word.store((cur & 0xffff_ffff) as u32, Ordering::Release);
            let tag = (cur >> 32).wrapping_add(1);
            let new = (id as u64) | (tag << 32);
            if head.compare_exchange(cur, new, Ordering::AcqRel, Ordering::Acquire).is_ok() {
                return;
            }
        }
    }

    /// Raise the high-water to at least `id + 1` (dual-write mode: ids are allocated by the
    /// host's existing allocator and mirrored in; the plane allocator is bypassed).
    pub fn ensure_high_water(&self, id: u32) {
        let hw = self.header_atomic_u64(H_ID_HIGH_WATER);
        let want = id as u64 + 1;
        let mut cur = hw.load(Ordering::Acquire);
        while cur < want {
            match hw.compare_exchange_weak(cur, want, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => break,
                Err(now) => cur = now,
            }
        }
    }

    pub fn id_high_water(&self) -> u64 {
        self.header_atomic_u64(H_ID_HIGH_WATER).load(Ordering::Acquire)
    }

    /// Entry point (id, level), read as one atomic word — a torn (new id, old level) pair
    /// would blind a racing search.
    pub fn entry_point(&self) -> (u32, u32) {
        let packed = self.header_atomic_u64(H_ENTRY).load(Ordering::Acquire);
        ((packed & 0xffff_ffff) as u32, (packed >> 32) as u32)
    }

    pub fn set_entry_point(&self, id: u32, level: u32) {
        self.header_atomic_u64(H_ENTRY).store((id as u64) | ((level as u64) << 32), Ordering::Release);
    }

    pub fn set_watermark(&self, txn: u64) {
        self.header_atomic_u64(H_TXN_WATERMARK).store(txn, Ordering::Release);
    }

    pub fn watermark(&self) -> u64 {
        self.header_atomic_u64(H_TXN_WATERMARK).load(Ordering::Acquire)
    }

    #[inline]
    pub fn upper_ptr(&self, idx: u32) -> *const u8 {
        debug_assert!((idx as u64) < self.upper_capacity);
        unsafe { self.map.as_ptr().add(self.upper_offset + idx as usize * upper_entry_size()) }
    }

    #[inline]
    pub fn upper_ptr_mut(&self, idx: u32) -> *mut u8 {
        self.upper_ptr(idx) as *mut u8
    }

    #[inline]
    pub fn upper_seq_atomic(&self, idx: u32) -> &AtomicU32 {
        unsafe { &*(self.upper_ptr(idx).add(U_SEQ) as *const AtomicU32) }
    }

    /// Allocate an upper-region entry: pop the upper freelist, else bump the high-water.
    /// Returns NO_UPPER when exhausted — the node then simply has no upper links, which
    /// degrades routing, not correctness. A dead entry's next-pointer lives in its first
    /// list bytes (offset U_LISTS), clobbered on reuse by the full rewrite.
    pub fn allocate_upper(&self) -> u32 {
        let head = self.header_atomic_u64(H_UPPER_FREELIST);
        loop {
            let cur = head.load(Ordering::Acquire);
            let idx = (cur & 0xffff_ffff) as u32;
            if idx == NO_UPPER {
                let hw = self.header_atomic_u64(H_UPPER_HIGH_WATER);
                let new = hw.fetch_add(1, Ordering::AcqRel);
                if new >= self.upper_capacity {
                    hw.fetch_sub(1, Ordering::AcqRel);
                    return NO_UPPER;
                }
                return new as u32;
            }
            let next = unsafe { (*(self.upper_ptr(idx).add(U_LISTS) as *const AtomicU32)).load(Ordering::Acquire) };
            let tag = (cur >> 32).wrapping_add(1);
            if head
                .compare_exchange(cur, (next as u64) | (tag << 32), Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return idx;
            }
        }
    }

    /// Return a dead upper entry to the freelist. Caller must have unlinked it from its
    /// node's slot (or marked the node deleted) first.
    pub fn free_upper(&self, idx: u32) {
        if idx == NO_UPPER {
            return;
        }
        let head = self.header_atomic_u64(H_UPPER_FREELIST);
        let next_word = unsafe { &*(self.upper_ptr(idx).add(U_LISTS) as *const AtomicU32) };
        loop {
            let cur = head.load(Ordering::Acquire);
            next_word.store((cur & 0xffff_ffff) as u32, Ordering::Release);
            let tag = (cur >> 32).wrapping_add(1);
            if head
                .compare_exchange(cur, (idx as u64) | (tag << 32), Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return;
            }
        }
    }

    pub fn set_clean_shutdown(&mut self, clean: bool) {
        self.map[H_CLEAN_SHUTDOWN] = clean as u8;
    }

    pub fn msync(&self) -> io::Result<()> {
        self.map.flush()
    }

    /// Durability barrier with watermark ordering: flush all data, then advance the
    /// watermark and mark the shutdown clean, then flush the header page alone. A crash
    /// between the two flushes leaves the OLD watermark over fully-durable data — replay
    /// re-covers a suffix, which is idempotent — never a new watermark over missing data.
    /// (A single whole-map msync cannot express "data before watermark": the kernel may
    /// write the header page back first.)
    pub fn flush_with_watermark(&self, txn: u64) -> io::Result<()> {
        self.map.flush()?;
        self.set_watermark(txn);
        unsafe { *(self.map.as_ptr().add(H_CLEAN_SHUTDOWN) as *mut u8) = 1 };
        self.map.flush_range(0, HEADER_SIZE)
    }
}
