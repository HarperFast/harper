//! Per-slot lock with owner identity. The lock word is a u32: bit 31 set = locked, low 31
//! bits = the owner handle's registry tag (see format.rs); unlocked values are generations
//! (bit 31 clear) that change on every release, so readers validate a consistent snapshot
//! seqlock-style.
//!
//! Crash recovery happens at the contended slot: a waiter that has watched the SAME locked
//! value for a full window asks `owner_dead(tag)` — implemented over kernel-owned file
//! locks that die with the owner's open handle, so it is immune to pid reuse, container
//! pid-1 restarts, and pid namespaces. Only a provably dead owner is taken over, and the
//! taker first runs `sanitize` (marking the payload deleted): a dead writer's payload is
//! half-written and must read as absent until rewritten. When liveness is unknowable
//! (non-Linux platforms, an unregistered handle), readers return `fallback()` after the
//! window instead of waiting forever, and writers keep waiting.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

pub const LOCKED: u32 = 1 << 31;
pub const GEN_MASK: u32 = LOCKED - 1;

/// How long a locked value must stay unchanged before the owner's liveness is checked.
const TAKEOVER_AFTER: Duration = Duration::from_millis(20);
/// Hard bound on waiting for a lock this thread cannot reclaim (owner alive-or-unknowable:
/// an unregistered handle's abandoned lock, a deadlocked live thread). A live writer's
/// critical section is microseconds, so five seconds of one unchanged locked value means
/// the slot is wedged — surfacing an error beats hanging a caller forever.
const WRITE_WEDGE_AFTER: Duration = Duration::from_secs(5);

/// The slot's lock could not be acquired or reclaimed within the wedge bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Wedged;
const SPINS_BEFORE_CLOCK: u32 = 1 << 10;

/// A fresh generation for a takeover release: the previous generation is unknowable, so it
/// must be a value no in-flight reader plausibly holds as its first snapshot.
#[inline]
fn fresh_generation() -> u32 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos ^ (std::process::id() << 10)) & GEN_MASK
}

pub struct SeqWriteGuard<'a> {
    seq: &'a AtomicU32,
    release_gen: u32,
}

impl Drop for SeqWriteGuard<'_> {
    fn drop(&mut self) {
        self.seq.store(self.release_gen, Ordering::Release);
    }
}

enum Stale {
    No,
    DeadOwner(u32),
    UnknownPastWindow,
}

/// Track how long one locked value has been observed; decide staleness.
struct StaleWatch {
    seen: u32,
    since: Instant,
}

impl StaleWatch {
    fn new() -> Self {
        StaleWatch { seen: 0, since: Instant::now() }
    }

    fn observe(&mut self, locked_value: u32, owner_dead: &impl Fn(u32) -> bool) -> Stale {
        if self.seen != locked_value {
            self.seen = locked_value;
            self.since = Instant::now();
            return Stale::No;
        }
        if self.since.elapsed() < TAKEOVER_AFTER {
            return Stale::No;
        }
        if owner_dead(locked_value & GEN_MASK) {
            Stale::DeadOwner(locked_value)
        } else {
            Stale::UnknownPastWindow
        }
    }
}

/// Acquire write ownership of a slot. `self_tag` identifies this handle in the lock word;
/// `sanitize` runs (holding the lock) only after a takeover from a dead owner; `owner_dead`
/// decides takeover eligibility. A lock held past the window by an owner that is alive or
/// unknowable is simply waited on.
pub fn write_lock<'a>(
    seq: &'a AtomicU32,
    self_tag: u32,
    sanitize: impl Fn(),
    owner_dead: impl Fn(u32) -> bool,
) -> Result<SeqWriteGuard<'a>, Wedged> {
    let mut spins = 0u32;
    let mut watch = StaleWatch::new();
    let mut wedged_since: Option<Instant> = None;
    loop {
        let cur = seq.load(Ordering::Acquire);
        if cur & LOCKED == 0 {
            if seq
                .compare_exchange_weak(cur, LOCKED | (self_tag & GEN_MASK), Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Ok(SeqWriteGuard { seq, release_gen: cur.wrapping_add(1) & GEN_MASK });
            }
            wedged_since = None;
        } else {
            spins += 1;
            if spins > SPINS_BEFORE_CLOCK {
                match watch.observe(cur, &owner_dead) {
                    Stale::DeadOwner(observed) => {
                        if seq
                            .compare_exchange(observed, LOCKED | (self_tag & GEN_MASK), Ordering::AcqRel, Ordering::Acquire)
                            .is_ok()
                        {
                            sanitize();
                            return Ok(SeqWriteGuard { seq, release_gen: fresh_generation() });
                        }
                        wedged_since = None;
                    }
                    Stale::UnknownPastWindow => {
                        // unreclaimable (unregistered owner tag, or an alive-but-stuck
                        // holder): bounded wait, then surface the wedge instead of hanging
                        let since = *wedged_since.get_or_insert_with(Instant::now);
                        if since.elapsed() > WRITE_WEDGE_AFTER {
                            return Err(Wedged);
                        }
                    }
                    // the lock VALUE moved: owners are cycling, i.e. real progress — a busy
                    // slot must never trip the wedge bound
                    Stale::No => wedged_since = None,
                }
                std::thread::yield_now();
                continue;
            }
        }
        std::hint::spin_loop();
    }
}

/// Run `read` until it observes a stable (unlocked, unchanged) generation. `read` must be
/// side-effect-free on retry. A dead owner's lock is taken over (sanitizing the payload)
/// and the read retried; an alive-or-unknowable owner past the window makes this return
/// `fallback()` rather than stall a search indefinitely.
#[inline]
pub fn read_consistent<T>(
    seq: &AtomicU32,
    self_tag: u32,
    mut read: impl FnMut() -> T,
    sanitize: impl Fn(),
    fallback: impl FnOnce() -> T,
    owner_dead: impl Fn(u32) -> bool,
) -> T {
    let mut spins = 0u32;
    let mut watch = StaleWatch::new();
    loop {
        let before = seq.load(Ordering::Acquire);
        if before & LOCKED == 0 {
            let value = read();
            std::sync::atomic::fence(Ordering::Acquire);
            if seq.load(Ordering::Relaxed) == before {
                return value;
            }
        } else {
            spins += 1;
            if spins > SPINS_BEFORE_CLOCK {
                match watch.observe(before, &owner_dead) {
                    Stale::DeadOwner(observed) => {
                        if seq
                            .compare_exchange(observed, LOCKED | (self_tag & GEN_MASK), Ordering::AcqRel, Ordering::Acquire)
                            .is_ok()
                        {
                            sanitize();
                            seq.store(fresh_generation(), Ordering::Release);
                        }
                    }
                    Stale::UnknownPastWindow => return fallback(),
                    Stale::No => {}
                }
                std::thread::yield_now();
                continue;
            }
        }
        std::hint::spin_loop();
    }
}
