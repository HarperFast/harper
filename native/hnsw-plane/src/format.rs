//! On-disk format: 4 KB header + fixed-size layer-0 slot array + upper-layer region.
//! See ../../../hnsw-native-plane.md §4. Format changes bump VERSION and require reindex.

use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

pub const MAGIC: u32 = 0x484e_5357; // "HNSW"
pub const VERSION: u32 = 1;
pub const HEADER_SIZE: usize = 4096;

// Header field byte offsets.
const H_MAGIC: usize = 0;
const H_VERSION: usize = 4;
const H_DIMS: usize = 8; // u16
const H_QUANT: usize = 10; // u8: 0 = int8, 1 = f32
const H_LAYER0_CAP: usize = 12; // u16
const H_SLOT_SIZE: usize = 16; // u32
const H_ENTRY_ID: usize = 24; // u32 (u32::MAX = none)
const H_ENTRY_LEVEL: usize = 28; // u32
const H_ID_HIGH_WATER: usize = 32; // u64 atomic
const H_FREELIST_HEAD: usize = 40; // u64 atomic: (tag << 32) | id; id u32::MAX = empty
const H_TXN_WATERMARK: usize = 48; // u64
const H_CLEAN_SHUTDOWN: usize = 56; // u8

// Slot layout offsets (within a slot).
pub const S_SEQ: usize = 0; // u32 seqlock
pub const S_FLAGS: usize = 4; // u8: bit0 = valid, bit1 = deleted
pub const S_LEVEL: usize = 5; // u8
pub const S_DEGREE: usize = 6; // u16
pub const S_SCALE: usize = 8; // f32
pub const S_INV_MAG: usize = 12; // f32
pub const S_VECTOR: usize = 16; // dims bytes (int8) or dims*4 (f32)
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
        let data_len = if slots_per_page > 0 {
            max_nodes.div_ceil(slots_per_page as u64) * PAGE as u64
        } else {
            max_nodes * slot_size as u64
        };
        let len = HEADER_SIZE as u64 + data_len;
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(path)?;
        file.set_len(len)?;
        let mut map = unsafe { MmapMut::map_mut(&file)? };
        map[H_MAGIC..H_MAGIC + 4].copy_from_slice(&MAGIC.to_le_bytes());
        map[H_VERSION..H_VERSION + 4].copy_from_slice(&VERSION.to_le_bytes());
        map[H_DIMS..H_DIMS + 2].copy_from_slice(&(dims as u16).to_le_bytes());
        map[H_QUANT] = 0;
        map[H_LAYER0_CAP..H_LAYER0_CAP + 2].copy_from_slice(&(layer0_cap as u16).to_le_bytes());
        map[H_SLOT_SIZE..H_SLOT_SIZE + 4].copy_from_slice(&(slot_size as u32).to_le_bytes());
        map[H_SLOTS_PER_PAGE..H_SLOTS_PER_PAGE + 2].copy_from_slice(&(slots_per_page as u16).to_le_bytes());
        map[H_ENTRY_ID..H_ENTRY_ID + 4].copy_from_slice(&NO_ID.to_le_bytes());
        map[H_FREELIST_HEAD..H_FREELIST_HEAD + 8]
            .copy_from_slice(&((NO_ID as u64) | 0u64 << 32).to_le_bytes());
        Ok(PlaneFile { map, dims, layer0_cap, slot_size, slots_per_page })
    }

    pub fn open(path: &Path) -> io::Result<Self> {
        let file = OpenOptions::new().read(true).write(true).open(path)?;
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
        Ok(PlaneFile { map, dims, layer0_cap, slot_size, slots_per_page })
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

    /// Allocate a node id: pop the freelist, else bump the high-water.
    pub fn allocate_id(&self) -> u32 {
        let head = self.header_atomic_u64(H_FREELIST_HEAD);
        loop {
            let cur = head.load(Ordering::Acquire);
            let id = (cur & 0xffff_ffff) as u32;
            if id == NO_ID {
                let hw = self.header_atomic_u64(H_ID_HIGH_WATER);
                return hw.fetch_add(1, Ordering::AcqRel) as u32;
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

    pub fn id_high_water(&self) -> u64 {
        self.header_atomic_u64(H_ID_HIGH_WATER).load(Ordering::Acquire)
    }

    pub fn entry_point(&self) -> (u32, u32) {
        let id = u32::from_le_bytes(self.map[H_ENTRY_ID..H_ENTRY_ID + 4].try_into().unwrap());
        let level = u32::from_le_bytes(self.map[H_ENTRY_LEVEL..H_ENTRY_LEVEL + 4].try_into().unwrap());
        (id, level)
    }

    pub fn set_entry_point(&self, id: u32, level: u32) {
        unsafe {
            (*(self.map.as_ptr().add(H_ENTRY_ID) as *const AtomicU32)).store(id, Ordering::Release);
            (*(self.map.as_ptr().add(H_ENTRY_LEVEL) as *const AtomicU32)).store(level, Ordering::Release);
        }
    }

    pub fn set_watermark(&self, txn: u64) {
        self.header_atomic_u64(H_TXN_WATERMARK).store(txn, Ordering::Release);
    }

    pub fn watermark(&self) -> u64 {
        self.header_atomic_u64(H_TXN_WATERMARK).load(Ordering::Acquire)
    }

    pub fn set_clean_shutdown(&mut self, clean: bool) {
        self.map[H_CLEAN_SHUTDOWN] = clean as u8;
    }

    pub fn msync(&self) -> io::Result<()> {
        self.map.flush()
    }
}
