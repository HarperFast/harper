//! Per-slot lock with owner identity. The lock word is a u32: bit 31 set = locked, low 31
//! bits = the owner's process id (Linux pid_max ≤ 2^22; macOS far lower). Unlocked values
//! are generations (bit 31 clear) that change on every release, so readers validate a
//! consistent snapshot exactly like a classic seqlock.
//!
//! Crash recovery: a lock persisted by a writer that died mid-write would wedge the slot
//! forever. A waiter that has watched the SAME locked value for a full window asks the OS
//! whether the owner is alive — takeover happens only when the pid is gone (ESRCH), never
//! on elapsed time alone, so a live writer descheduled by CFS throttling, a page-fault
//! storm, or oversubscription is never robbed (its critical section is microseconds; it
//! finishes when rescheduled). The taker SANITIZES the slot (caller-supplied closure marks
//! it invalid) before releasing: a dead writer's payload is half-written, and publishing it
//! as consistent would serve a spliced vector — invisible-until-rewritten is the contract.
//! On non-unix platforms liveness is unknowable here, so no takeover happens: readers skip
//! the slot after the window (degraded, safe) and writers keep waiting.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

const LOCKED: u32 = 1 << 31;
const GEN_MASK: u32 = LOCKED - 1;

/// How long a locked value must stay unchanged before the owner's liveness is checked.
const TAKEOVER_AFTER: Duration = Duration::from_millis(20);
const SPINS_BEFORE_CLOCK: u32 = 1 << 10;

#[inline]
fn self_pid() -> u32 {
    std::process::id() & GEN_MASK
}

/// A fresh generation for a takeover release: the previous generation is unknowable, so it
/// must be a value no in-flight reader plausibly holds as its first snapshot.
#[inline]
fn fresh_generation() -> u32 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos ^ (self_pid() << 10)) & GEN_MASK
}

#[cfg(unix)]
fn owner_is_dead(pid: u32) -> bool {
    // ESRCH = no such process. EPERM means it exists but is not ours: alive.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return false;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn owner_is_dead(_pid: u32) -> bool {
    false // unknowable here: never take over (readers skip, writers wait)
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

    fn observe(&mut self, locked_value: u32) -> Stale {
        if self.seen != locked_value {
            self.seen = locked_value;
            self.since = Instant::now();
            return Stale::No;
        }
        if self.since.elapsed() < TAKEOVER_AFTER {
            return Stale::No;
        }
        let pid = locked_value & GEN_MASK;
        if owner_is_dead(pid) {
            Stale::DeadOwner(locked_value)
        } else {
            Stale::UnknownPastWindow
        }
    }
}

/// Acquire write ownership of a slot. `sanitize` runs (holding the lock) only when the lock
/// was taken over from a dead owner — it must mark the protected payload invalid, because a
/// dead writer left it half-written.
pub fn write_lock<'a>(seq: &'a AtomicU32, sanitize: impl Fn()) -> SeqWriteGuard<'a> {
    let mut spins = 0u32;
    let mut watch = StaleWatch::new();
    loop {
        let cur = seq.load(Ordering::Acquire);
        if cur & LOCKED == 0 {
            if seq
                .compare_exchange_weak(cur, LOCKED | self_pid(), Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return SeqWriteGuard { seq, release_gen: cur.wrapping_add(1) & GEN_MASK };
            }
        } else {
            spins += 1;
            if spins > SPINS_BEFORE_CLOCK {
                if let Stale::DeadOwner(observed) = watch.observe(cur) {
                    if seq
                        .compare_exchange(observed, LOCKED | self_pid(), Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                    {
                        sanitize();
                        return SeqWriteGuard { seq, release_gen: fresh_generation() };
                    }
                }
                std::thread::yield_now();
                continue;
            }
        }
        std::hint::spin_loop();
    }
}

/// Run `read` until it observes a stable (unlocked, unchanged) generation. `read` must be
/// side-effect-free on retry. A lock held by a dead owner is taken over and the payload
/// sanitized (marked invalid) before this thread re-reads; on platforms where liveness is
/// unknowable, a lock past the window makes this return `fallback()` instead of waiting
/// forever.
#[inline]
pub fn read_consistent<T>(
    seq: &AtomicU32,
    mut read: impl FnMut() -> T,
    sanitize: impl Fn(),
    fallback: impl FnOnce() -> T,
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
                match watch.observe(before) {
                    Stale::DeadOwner(observed) => {
                        if seq
                            .compare_exchange(observed, LOCKED | self_pid(), Ordering::AcqRel, Ordering::Acquire)
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
