//! Per-slot seqlock. Writer: bump seq to odd → mutate → bump to even.
//! Reader: snapshot seq (spin past odd), read, re-check. No cross-slot atomicity by design —
//! traversal tolerates torn *graphs* (skipped edges), but never torn *slots*.

use std::sync::atomic::{AtomicU32, Ordering};

pub struct SeqWriteGuard<'a> {
    seq: &'a AtomicU32,
}

/// Acquire write ownership of a slot, spinning while another writer holds it odd.
pub fn write_lock(seq: &AtomicU32) -> SeqWriteGuard<'_> {
    let mut spins = 0u32;
    loop {
        let cur = seq.load(Ordering::Acquire);
        if cur & 1 == 0
            && seq
                .compare_exchange_weak(cur, cur.wrapping_add(1), Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            return SeqWriteGuard { seq };
        }
        spins += 1;
        if spins > 1 << 10 {
            // a preempted or slow writer (e.g. a coverage prune) holds this slot: burn no
            // more cores; persisted-odd values are scrubbed at open, so this always ends
            std::thread::yield_now();
        } else {
            std::hint::spin_loop();
        }
    }
}

impl Drop for SeqWriteGuard<'_> {
    fn drop(&mut self) {
        // odd -> even: publishes the write
        self.seq.fetch_add(1, Ordering::Release);
    }
}

/// Run `read` until it observes a stable (even, unchanged) sequence. `read` must be
/// side-effect-free on retry and must not dereference data whose validity depends on seq.
#[inline]
pub fn read_consistent<T>(seq: &AtomicU32, mut read: impl FnMut() -> T) -> T {
    let mut spins = 0u32;
    loop {
        let before = seq.load(Ordering::Acquire);
        if before & 1 == 0 {
            let value = read();
            std::sync::atomic::fence(Ordering::Acquire);
            if seq.load(Ordering::Relaxed) == before {
                return value;
            }
        }
        spins += 1;
        if spins > 1 << 10 {
            std::thread::yield_now();
        } else {
            std::hint::spin_loop();
        }
    }
}
