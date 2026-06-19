// QA-159 — WebSocket subscription transport instrumentation.
//
// GOAL: observe, per worker process, the EXACT subscription-layer teardown timing for the
// WebSocket subscribe path, to test the F-024 contrast (WS = prompt iterator.return() on
// disconnect, vs SSE deferral).
//
// MECHANISM (verified against harper 7aaa5a152):
//   server/REST.ts `scope.server.ws(...)` handler on a WS 'close' event calls
//   `iterator.return()` (REST.ts:341) — that is the prompt teardown wiring QA-127 noted.
//   `iterator.return()` on a core Subscription (resources/transactionBroadcast.ts) emits
//   'close', which runs Subscription.end() and decrements databaseSubscriptions.activeCount.
//
//   The core activeCount registry (allSubscriptions) is module-private, so instead of
//   reaching into it we wrap the REAL subscription: `Live` extends the Burst table and its
//   connect() delegates to the REAL Table.subscribe (super.subscribe -> core Subscription),
//   then we attach our own once('close') to that very subscription object. Our counter
//   therefore decrements at the SAME instant core's activeCount does — i.e. it is a faithful
//   proxy for the subscription-layer teardown, with NO core changes.
//
// All counters live on a process-global so single-worker and multi-worker (threads.count:N)
// runs are both observable; Probe returns this worker's slice + pid so the test can sum
// across workers and detect per-worker leaks.

import { threadId } from 'node:worker_threads';

const G = (globalThis.__QA159__ ??= {
	// Harper runs HTTP workers as worker_threads, which SHARE process.pid — so we key per-worker
	// state by threadId (unique per worker thread) for correct cross-worker aggregation.
	pid: `${process.pid}:t${threadId}`,
	opened: 0, // # of Live WS subscriptions that attached (subscribe returned)
	closed: 0, // # whose 'close' teardown fired (iterator.return on disconnect / end)
	teardownErrors: 0,
	maxConcurrent: 0, // high-water mark of (opened-closed)
	lastCloseAt: 0, // wall-clock of most recent teardown (latency probing)
	lastOpenAt: 0,
});

// Live: custom resource over the Burst store. connect() is what the WS path invokes; we route
// to the REAL Table.subscribe so the returned iterable is the genuine core Subscription, then
// instrument its lifecycle. Filtering/delivery semantics are unchanged from a plain table sub.
export class Live extends tables.Burst {
	connect(target, incomingMessages, request) {
		// Mirror the default Resource.connect query selection (resources/Resource.ts:405): for a
		// loadAsInstance resource the subscribe query is `incomingMessages` unless that's not a
		// subscription target; for our record/collection WS path `target` carries the id. Pass
		// `target` (the RequestTarget) — Table.subscribe reads its id via requestTargetToId.
		// super.subscribe is resources/Table.ts subscribe() -> core Subscription (IterableEventQueue).
		const subPromise = Promise.resolve(super.subscribe(target));
		return subPromise.then((sub) => {
			G.opened++;
			G.lastOpenAt = Date.now();
			const live = G.opened - G.closed;
			if (live > G.maxConcurrent) G.maxConcurrent = live;
			let torn = false;
			const onClose = () => {
				if (torn) return;
				torn = true;
				try {
					G.closed++;
					G.lastCloseAt = Date.now();
				} catch {
					G.teardownErrors++;
				}
			};
			// 'close' is emitted by the core Subscription's iterator.return()/throw() — exactly
			// the REST.ts WS 'close' -> iterator.return() teardown (and end-of-stream). This is
			// the F-024 detection hook: it fires PROMPTLY for WS, deferred for SSE.
			if (typeof sub.once === 'function') sub.once('close', onClose);
			return sub;
		});
	}
}

// Probe: read this worker's WS-subscription lifecycle ledger.
export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return {
			pid: G.pid,
			opened: G.opened,
			closed: G.closed,
			activeSubs: G.opened - G.closed, // should settle to (currently-connected WS subs)
			maxConcurrent: G.maxConcurrent,
			teardownErrors: G.teardownErrors,
			lastOpenAt: G.lastOpenAt,
			lastCloseAt: G.lastCloseAt,
			// out-of-band transport-layer leak signal: open socket handles in this worker.
			activeHandles: typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : -1,
			rss: process.memoryUsage().rss,
			heapUsed: process.memoryUsage().heapUsed,
		};
	}
}
