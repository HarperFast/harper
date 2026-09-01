//! On-disk format: 4 KB header + fixed-size layer-0 slot array + upper-layer region.
//! See ../../../hnsw-native-plane.md §4. Format changes bump VERSION and require reindex.

use memmap2::MmapMut;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

pub const MAGIC: u32 = 0x484e_5357; // "HNSW"
pub const VERSION: u32 = 6; // v6: 4-aligned neighbor + upper id arrays (older files: reindex)
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
const H_ENTRY_PREV: usize = 88; // u64: last replaced entry point (re-election hint)
// Opener registry: each live handle claims one slot, writes its random tag there, and holds
// a kernel OFD byte-range lock on the slot (released automatically when the handle - or its
// whole process - dies). A lock word's owner is dead iff its registry slot no longer carries
// its tag or the slot's byte range is lockable. Immune to pid reuse and pid namespaces.
const H_REGISTRY: usize = 128; // u32 x REGISTRY_SLOTS
pub const REGISTRY_SLOTS: usize = 64;

/// Upper-layer region geometry: fixed entries covering levels 1..=MAX_UPPER_LEVELS at
/// UPPER_CAP ids per level. P(level >= 1) = 1/M ~ 6.25%; the region reserves entries for
/// 1/8 of max_nodes (2x headroom). P(level >= 9) at mL = 1/ln16 is ~e^-25 — unreachable.
pub const MAX_UPPER_LEVELS: usize = 8;
pub const UPPER_CAP: usize = 64; // matches the JS graph's upper cap (M<<2 under optimizeRouting)
// entry: seq u32 | levels u8 | pad | per-level (degree u16 + pad u16 + ids u32*UPPER_CAP)
pub const U_SEQ: usize = 0;
pub const U_LEVELS: usize = 4;
pub const U_LISTS: usize = 8;
/// The pad follows the degree rather than the ids so every id array starts 4-aligned; the
/// stride (and so the entry size) is unchanged either way.
pub const UL_DEGREE: usize = 0;
pub const UL_IDS: usize = 4;
pub const UPPER_LEVEL_STRIDE: usize = UL_IDS + UPPER_CAP * 4;
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
                                // neighbors: u32 * layer0_cap, follows the 4-padded vector

/// Byte offset of a slot's neighbor array. The vector is padded to a 4-byte boundary so this
/// is 4-aligned for every dims: the search hot path then reads each neighbor as one aligned
/// volatile u32 instead of four byte loads plus shifts.
#[inline]
pub const fn neighbor_offset(dims: usize) -> usize {
    S_VECTOR + (dims + 3) / 4 * 4
}

pub const FLAG_VALID: u8 = 1;
pub const FLAG_DELETED: u8 = 2;
pub const NO_ID: u32 = u32::MAX;

pub struct PlaneFile {
    /// Kept open for the lifetime of the mapping: the opener-registry OFD lock lives on it.
    file: std::fs::File,
    /// This handle's registry tag (low bits encode its registry slot). 0 = unregistered
    /// (registry full or platform without OFD locks): this handle's own dead locks cannot be
    /// reclaimed by others, and it never reclaims.
    pub self_tag: u32,
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

/// MADV_RANDOM: hosts packing many instances live in permanent memory pressure, where
/// evict-and-refault is steady state; default readahead pulls ~16 unwanted pages per random
/// re-fault, taxing every tenant's page cache. The plane has no sequential reader to protect
/// (search is pointer-chasing, the builder writes, backfill scans read the host store).
fn advise_random(map: &MmapMut) {
    #[cfg(unix)]
    let _ = map.advise(memmap2::Advice::Random);
    #[cfg(not(unix))]
    let _ = map;
}

fn slot_size_for(dims: usize, layer0_cap: usize) -> usize {
    let raw = neighbor_offset(dims) + layer0_cap * 4;
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
        if max_nodes >= NO_ID as u64 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "maxNodes must be below 2^32-1"));
        }
        let slot_size = slot_size_for(dims, layer0_cap);
        let slots_per_page = slots_per_page_for(slot_size);
        let data_len = slot_region_len(max_nodes, slot_size, slots_per_page);
        let upper_capacity = max_nodes / 8 + 64;
        let len = HEADER_SIZE as u64 + data_len + upper_capacity * upper_entry_size() as u64;
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(path)?;
        file.set_len(len)?;
        let mut map = unsafe { MmapMut::map_mut(&file)? };
        advise_random(&map);
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
        // zero would read as "node 0 was the previous entry point" and hand every re-election
        // and search-side repair a candidate that was never an entry point
        map[H_ENTRY_PREV..H_ENTRY_PREV + 8].copy_from_slice(&(NO_ID as u64).to_le_bytes());
        map[H_VERSION..H_VERSION + 4].copy_from_slice(&VERSION.to_le_bytes());
        std::sync::atomic::fence(Ordering::Release);
        map[H_MAGIC..H_MAGIC + 4].copy_from_slice(&MAGIC.to_le_bytes());
        let upper_offset = HEADER_SIZE + slot_region_len(max_nodes, slot_size, slots_per_page) as usize;
        let mut plane = PlaneFile {
            file,
            self_tag: 0,
            map,
            dims,
            layer0_cap,
            slot_size,
            max_nodes,
            upper_offset,
            upper_capacity,
            slots_per_page,
            opened_clean: true,
        };
        plane.register_opener();
        Ok(plane)
    }

    pub fn open(path: &Path) -> io::Result<Self> {
        let file = OpenOptions::new().read(true).write(true).open(path)?;
        let file_len = file.metadata()?.len();
        if file_len < HEADER_SIZE as u64 {
            // a truncated or interrupted create must be a catchable error, not a slice panic
            return Err(io::Error::new(io::ErrorKind::InvalidData, "plane file shorter than its header: recreate the index"));
        }
        let map = unsafe { MmapMut::map_mut(&file)? };
        advise_random(&map);
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
        if max_nodes > NO_ID as u64 || slots_per_page != slots_per_page_for(slot_size) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "plane header geometry is inconsistent: recreate the index"));
        }
        let upper_offset = HEADER_SIZE + slot_region_len(max_nodes, slot_size, slots_per_page) as usize;
        let upper_capacity = max_nodes / 8 + 64;
        let expected = (upper_offset as u64)
            .checked_add(upper_capacity.checked_mul(upper_entry_size() as u64).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "plane header geometry overflows: recreate the index")
            })?)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "plane header geometry overflows: recreate the index"))?;
        if file_len < expected {
            // header-valid but short (rsync/backup truncation): mid-range slot_ptr/upper_ptr
            // would otherwise read off the mapping
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("plane file is {file_len} bytes but its header implies {expected}: recreate the index"),
            ));
        }
        let opened_clean = map[H_CLEAN_SHUTDOWN] == 1;
        let mut plane = PlaneFile {
            file,
            self_tag: 0,
            map,
            dims,
            layer0_cap,
            slot_size,
            max_nodes,
            upper_offset,
            upper_capacity,
            slots_per_page,
            opened_clean,
        };
        plane.register_opener();
        let hw = plane.id_high_water();
        if hw > max_nodes {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "plane header id high-water exceeds capacity: recreate the index"));
        }
        // No open-time repair: seqlocks persisted odd by a dead writer are taken over lazily
        // at the contended slot (seqlock.rs) — a whole-file scrub would page in the entire
        // mapping and, with another process still mapping the file, could force a LIVE
        // writer's lock. The clean-shutdown byte remains advisory metadata only.
        Ok(plane)
    }

    /// Force any persisted-odd seqlocks (slot + upper regions) back to even after an unclean
    /// shutdown. Safe because open() runs before any concurrent access exists.
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
            if (id as u64) >= self.max_nodes {
                // corrupt freelist head (file-sourced): drop the chain rather than compute
                // out-of-mapping pointers; capacity continues via the high-water
                let _ = head.compare_exchange(cur, NO_ID as u64, Ordering::AcqRel, Ordering::Acquire);
                continue;
            }
            // next-pointer lives in the dead slot's scale field rather than its first neighbor
            // word: the neighbor array is a live reader's aligned volatile load target, and a
            // freelist pointer parked there would be decoded as a neighbor id
            let next = unsafe { (*(self.slot_ptr(id).add(S_SCALE) as *const AtomicU32)).load(Ordering::Acquire) };
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
        let next_word = unsafe { &*(self.slot_ptr(id).add(S_SCALE) as *const AtomicU32) };
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

    pub fn upper_high_water(&self) -> u64 {
        self.header_atomic_u64(H_UPPER_HIGH_WATER).load(Ordering::Acquire)
    }

    /// Entry point (id, level), read as one atomic word — a torn (new id, old level) pair
    /// would blind a racing search.
    pub fn entry_point(&self) -> (u32, u32) {
        let packed = self.header_atomic_u64(H_ENTRY).load(Ordering::Acquire);
        ((packed & 0xffff_ffff) as u32, (packed >> 32) as u32)
    }

    pub fn set_entry_point(&self, id: u32, level: u32) {
        let prev = self.header_atomic_u64(H_ENTRY).swap((id as u64) | ((level as u64) << 32), Ordering::AcqRel);
        self.record_previous_entry(prev, id);
    }

    /// Remember the entry point a PROMOTION displaced. Only promotions are recorded: the node
    /// they displace was live and high-level, which is what makes it a usable hint. Recording
    /// a re-election's replacement instead would fill the hint with the dead node that forced
    /// the re-election.
    #[inline]
    fn record_previous_entry(&self, prev_packed: u64, new_id: u32) {
        let prev_id = (prev_packed & 0xffff_ffff) as u32;
        if prev_id == NO_ID || prev_id == new_id || (prev_id as u64) >= self.max_nodes {
            return;
        }
        // a hint is only worth keeping while its node is live: the host mirrors a post-delete
        // re-election through this same call, and storing the node that died would evict a
        // usable hint with one the repair path can never follow
        // volatile like every other read of a field a concurrent writer mutates (graph.rs's
        // `vread`): this one is outside the slot seqlock, so the retry cannot even catch a tear
        if unsafe { self.slot_ptr(prev_id).add(S_FLAGS).read_volatile() } != FLAG_VALID {
            return;
        }
        self.header_atomic_u64(H_ENTRY_PREV).store(prev_packed, Ordering::Release);
    }

    /// Claim the entry point of an EMPTY graph: a strict compare-exchange from the empty
    /// encoding, so exactly one racer wins. `set_entry_point_if_not_better` cannot serve here —
    /// it is a not-worse install, so a second first-inserter would replace the winner with its
    /// own edgeless node and orphan everything already rooted at the winner. A loser must join
    /// the winner's graph instead of returning an unlinked node.
    pub fn claim_entry_if_empty(&self, id: u32, level: u32) -> bool {
        self.header_atomic_u64(H_ENTRY)
            .compare_exchange(NO_ID as u64, (id as u64) | ((level as u64) << 32), Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// Entry-point CAS for re-election: install (id, level) only while the current entry is
    /// still `expected_id` or is of a lower level — a concurrent insert that just promoted a
    /// higher-level entry must not be clobbered by a delete's level-0 survivor.
    pub fn set_entry_point_if_not_better(&self, id: u32, level: u32, expected_id: u32) {
        self.cas_entry_if_not_better(id, level, expected_id, false);
    }

    /// The same CAS for an insert that PROMOTED itself above the entry it observed: the
    /// displaced entry is live, so it is recorded as the previous-entry hint that re-election
    /// and the search-side repair both consult before any O(high-water) scan.
    pub fn promote_entry_point(&self, id: u32, level: u32, expected_id: u32) {
        self.cas_entry_if_not_better(id, level, expected_id, true);
    }

    fn cas_entry_if_not_better(&self, id: u32, level: u32, expected_id: u32, record_prev: bool) {
        let cell = self.header_atomic_u64(H_ENTRY);
        let new = (id as u64) | ((level as u64) << 32);
        let mut cur = cell.load(Ordering::Acquire);
        loop {
            let cur_id = (cur & 0xffff_ffff) as u32;
            let cur_level = (cur >> 32) as u32;
            if cur_id != expected_id && cur_id != NO_ID && cur_level > level {
                return; // someone installed a better entry meanwhile
            }
            match cell.compare_exchange(cur, new, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => {
                    if record_prev {
                        self.record_previous_entry(cur, id);
                    }
                    return;
                }
                Err(now) => cur = now,
            }
        }
    }

    /// Install `(id, level)` ONLY while the entry still names `expected_id`. The read-side
    /// repair publishes through this rather than `set_entry_point_if_not_better`: the entry it
    /// is replacing is dead, so "not worse" is the wrong test — a concurrent first insert that
    /// just claimed the header with a level-0 root would lose to a higher-level repair
    /// candidate and be orphaned with nothing pointing at it.
    pub fn replace_entry_if(&self, expected_id: u32, id: u32, level: u32) -> bool {
        let cell = self.header_atomic_u64(H_ENTRY);
        let new = (id as u64) | ((level as u64) << 32);
        let mut cur = cell.load(Ordering::Acquire);
        while (cur & 0xffff_ffff) as u32 == expected_id {
            match cell.compare_exchange(cur, new, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return true,
                Err(now) => cur = now,
            }
        }
        false
    }

    /// Clear the entry point, but only while it still names `expected_id`. A re-election that
    /// found no candidate must not erase an entry a concurrent insert installed meanwhile —
    /// `set_entry_point_if_not_better(NO_ID, 0, ..)` would, because a level-0 live entry is not
    /// "better" than the level-0 clear.
    pub fn clear_entry_point_if(&self, expected_id: u32) {
        let cell = self.header_atomic_u64(H_ENTRY);
        let mut cur = cell.load(Ordering::Acquire);
        while (cur & 0xffff_ffff) as u32 == expected_id {
            match cell.compare_exchange(cur, NO_ID as u64, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return,
                Err(now) => cur = now,
            }
        }
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
            if idx != NO_UPPER && (idx as u64) >= self.upper_capacity {
                // corrupt upper freelist head (file-sourced): drop the chain
                let _ = head.compare_exchange(cur, NO_UPPER as u64, Ordering::AcqRel, Ordering::Acquire);
                continue;
            }
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
        if idx == NO_UPPER || (idx as u64) >= self.upper_capacity {
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

    #[inline]
    fn registry_tag_cell(&self, slot: usize) -> &AtomicU32 {
        unsafe { &*(self.map.as_ptr().add(H_REGISTRY + slot * 4) as *const AtomicU32) }
    }

    /// Claim a registry slot for this handle: take the slot's kernel byte-range lock (held
    /// until this handle closes; released by the kernel if the process dies) and publish a
    /// random tag whose low bits name the slot. On platforms without OFD locks, or with the
    /// registry full, the handle stays unregistered (tag 0): it still works, but its own
    /// abandoned locks are unreclaimable and it never reclaims others'.
    fn register_opener(&mut self) {
        #[cfg(target_os = "linux")]
        for slot in 0..REGISTRY_SLOTS {
            if !self.try_lock_registry_slot(slot, false) {
                continue;
            }
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            // identity = slot (low 6 bits) + a random per-open epoch (12 bits, nonzero):
            // a dead lock value pointing at a since-re-occupied slot is recognized as dead
            // by the epoch mismatch — the container same-pid restart lands exactly here
            let mut epoch = (nanos ^ std::process::id().rotate_left(16) ^ (self as *const _ as u32)) & 0xfff;
            if epoch == 0 {
                epoch = 1;
            }
            let tag = (epoch << 6) | slot as u32;
            self.registry_tag_cell(slot).store(tag, Ordering::Release);
            self.self_tag = tag;
            return;
        }
    }

    /// Try to take the OFD write lock on a registry slot's byte range. `probe` releases it
    /// immediately (liveness check); otherwise it is held for this handle's lifetime.
    #[cfg(target_os = "linux")]
    fn try_lock_registry_slot(&self, slot: usize, probe: bool) -> bool {
        use std::os::unix::io::AsRawFd;
        let mut fl: libc::flock = unsafe { std::mem::zeroed() };
        fl.l_type = libc::F_WRLCK as libc::c_short;
        fl.l_whence = libc::SEEK_SET as libc::c_short;
        fl.l_start = (H_REGISTRY + slot * 4) as libc::off_t;
        fl.l_len = 4;
        let got = unsafe { libc::fcntl(self.file.as_raw_fd(), libc::F_OFD_SETLK, &fl) } == 0;
        if got && probe {
            fl.l_type = libc::F_UNLCK as libc::c_short;
            unsafe { libc::fcntl(self.file.as_raw_fd(), libc::F_OFD_SETLK, &fl) };
        }
        got
    }

    /// Whether the handle behind a lock value is gone. Lock values carry a per-acquisition
    /// salt in their upper bits, so ownership is keyed on the registry SLOT (low bits): the
    /// owner is dead only with positive evidence — no registration in the slot, or the
    /// slot's kernel lock acquirable (its holder's open handle closed; process death
    /// included). Our own slot is always alive (probing our own OFD lock would succeed and
    /// lie). A dead value pointing at a slot since re-occupied by a NEW live handle reads
    /// alive; the bounded writer wedge covers that rare mis-attribution.
    pub fn tag_is_dead(&self, lock_value: u32) -> bool {
        let identity = lock_value & crate::seqlock::TAG_MASK;
        if identity == 0 {
            return false; // unregistered owner: unknowable
        }
        if self.self_tag != 0 && identity == self.self_tag {
            // ourselves: probing our own OFD lock from the same description would succeed
            // and lie, so self is answered structurally
            return false;
        }
        let slot = (identity as usize) & (REGISTRY_SLOTS - 1);
        let registered = self.registry_tag_cell(slot).load(Ordering::Acquire);
        if registered == 0 || registered != identity {
            return true; // slot empty, or re-occupied by a different epoch: owner departed
        }
        #[cfg(target_os = "linux")]
        {
            self.try_lock_registry_slot(slot, true)
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    }

    /// The re-election hint: the entry point most recently replaced by a promotion.
    pub fn previous_entry_point(&self) -> u32 {
        (self.header_atomic_u64(H_ENTRY_PREV).load(Ordering::Acquire) & 0xffff_ffff) as u32
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
    pub fn flush_with_watermark(&self, txn: Option<u64>) -> io::Result<()> {
        self.map.flush()?;
        if let Some(txn) = txn {
            // None must not TOUCH the watermark: a cadence barrier reading-then-rewriting it
            // on a pool thread could write a stale value over a completion stamp
            self.set_watermark(txn);
        }
        unsafe { *(self.map.as_ptr().add(H_CLEAN_SHUTDOWN) as *mut u8) = 1 };
        self.map.flush_range(0, HEADER_SIZE)
    }

    /// Mark the plane an incomplete mirror, durably, and nothing else: zero the watermark and
    /// msync the header page alone. Every opener then refuses to search it and rebuilds.
    ///
    /// Deliberately NOT `flush_with_watermark(Some(0))`: that writes the whole mapping back
    /// first, and the caller invalidating a multi-GB plane cannot pay a full msync inline —
    /// which is why the host used to queue an async flush and create its `.stale` sidecar
    /// before the flush had happened at all. Skipping the data flush is sound because the
    /// data is being discarded, and because lowering the watermark is the safe direction:
    /// the ordering hazard `flush_with_watermark` exists to prevent is a NEW watermark over
    /// missing data, never an old one over durable data.
    pub fn invalidate(&self) -> io::Result<()> {
        self.set_watermark(0);
        self.map.flush_range(0, HEADER_SIZE)
    }
}
