//! Per-slot seqlock. Writer: bump seq to odd → mutate → bump to even.
//! Reader: snapshot seq (spin past odd), read, re-check. No cross-slot atomicity by design —
//! traversal tolerates torn *graphs* (skipped edges), but never torn *slots*.
//!
//! Crash recovery is handled HERE, not by an open-time scrub: a seq persisted odd by a
//! writer that died mid-write would otherwise wedge every later reader and writer of that
//! slot forever. A live writer's seq always advances within a scheduler quantum or two
//! (slot writes are microseconds), so an odd seq that stays UNCHANGED for a full takeover
//! window has no owner — the waiter forces it even and proceeds. The slot's payload may be
//! half-written; that is the documented relaxed contract (a torn slot heals on rewrite, and
//! hosts filter wrong candidates via exact rescore), and an open-time scrub could not
//! distinguish it either. This also stays correct with multiple processes mapping the file,
//! where "open() runs before concurrent access" does not hold.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

/// How long an odd seq must stay unchanged before it is declared abandoned. Long enough that
/// a live writer preempted mid-write (microsecond-scale critical sections) is never robbed
/// under any plausible scheduling; short enough that a crashed writer costs milliseconds,
/// not a wedged thread.
const TAKEOVER_AFTER: Duration = Duration::from_millis(20);
const SPINS_BEFORE_CLOCK: u32 = 1 << 10;

pub struct SeqWriteGuard<'a> {
    seq: &'a AtomicU32,
}

/// Force an abandoned odd seq to even. Returns true if this thread performed the takeover.
fn take_over_abandoned(seq: &AtomicU32, observed_odd: u32) -> bool {
    seq.compare_exchange(observed_odd, observed_odd.wrapping_add(1), Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

/// Acquire write ownership of a slot, spinning while another writer holds it odd. An odd seq
/// that never advances belongs to a dead writer and is taken over.
pub fn write_lock(seq: &AtomicU32) -> SeqWriteGuard<'_> {
    let mut spins = 0u32;
    let mut stale_since: Option<(u32, Instant)> = None;
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
        if spins > SPINS_BEFORE_CLOCK {
            if cur & 1 == 1 {
                match stale_since {
                    Some((seen, at)) if seen == cur => {
                        if at.elapsed() > TAKEOVER_AFTER {
                            take_over_abandoned(seq, cur);
                            stale_since = None;
                        }
                    }
                    _ => stale_since = Some((cur, Instant::now())),
                }
            }
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
/// An odd seq that never advances belongs to a dead writer and is taken over (the payload
/// may be torn; the relaxed contract covers it).
#[inline]
pub fn read_consistent<T>(seq: &AtomicU32, mut read: impl FnMut() -> T) -> T {
    let mut spins = 0u32;
    let mut stale_since: Option<(u32, Instant)> = None;
    loop {
        let before = seq.load(Ordering::Acquire);
        if before & 1 == 0 {
            let value = read();
            std::sync::atomic::fence(Ordering::Acquire);
            if seq.load(Ordering::Relaxed) == before {
                return value;
            }
            stale_since = None;
        } else {
            match stale_since {
                Some((seen, at)) if seen == before => {
                    if at.elapsed() > TAKEOVER_AFTER {
                        take_over_abandoned(seq, before);
                        stale_since = None;
                        continue;
                    }
                }
                _ => stale_since = Some((before, Instant::now())),
            }
        }
        spins += 1;
        if spins > SPINS_BEFORE_CLOCK {
            std::thread::yield_now();
        } else {
            std::hint::spin_loop();
        }
    }
}
