// QA-537 — regression verify for #1628 ("Fix SSE hang on finite generator streamed to
// completion", PR #1632, commit 69c8c89a9).
//
// Bug recap: transformIterable (server/serverHelpers/contentTypes.ts) used to call the SSE
// `serialize` transform on the generator's TERMINAL `{ value: undefined, done: true }` step
// too. serialize()'s first line dereferences `message.acknowledge`, so `undefined.acknowledge`
// threw a TypeError inside Readable.from's pull loop — an uncaughtException that left the SSE
// HTTP response hanging (never closed) whenever a plain finite async generator was streamed to
// completion over `Accept: text/event-stream`. The fix guards transformIterable to pass the
// terminal `done` step through untransformed in both the sync and async branches.
//
// This fixture exercises multiple finite-generator shapes over SSE (dispatched via
// `resource.connect()`, which is what Harper's REST layer invokes for CONNECT/SSE requests —
// see server/REST.ts: `isSse` sets method to 'CONNECT', which calls `resource.connect(...)`):
//   FiniteGen  - canonical case: 5 events then a bare `return` (natural completion).
//   EmptyGen   - 0 events: generator returns immediately, hitting the terminal step first.
//   SingleGen  - exactly 1 event then completion.
//   ThrowGen   - yields 2 of an intended 5 events, then throws (partway failure, not the
//                terminal-`done` code path; the full throw contract is anchored by the
//                sse-throw-midstream fixture instead).
//   LargeGen   - 3000 events then completion (larger finite stream, same terminal-step path).
//   Probe      - readiness + per-resource open/close lifecycle counters, plain JSON.

const G = (globalThis.__QA537__ ??= {
	finite: { opened: 0, closed: 0 },
	empty: { opened: 0, closed: 0 },
	single: { opened: 0, closed: 0 },
	throwGen: { opened: 0, closed: 0 },
	large: { opened: 0, closed: 0 },
});

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// GET /FiniteGen/ (Accept: text/event-stream) — canonical finite generator, N=5.
export class FiniteGen extends Resource {
	static loadAsInstance = false;
	static async *connect(_target, _incomingMessages, _request) {
		G.finite.opened++;
		try {
			for (let i = 0; i < 5; i++) {
				yield { n: i };
				await sleep(2);
			}
		} finally {
			G.finite.closed++;
		}
	}
}

// GET /EmptyGen/ (Accept: text/event-stream) — 0 events; the terminal `done` step is the
// very FIRST step produced, so this isolates the terminal-step handling from any mid-stream
// yields at all.
export class EmptyGen extends Resource {
	static loadAsInstance = false;
	// eslint-disable-next-line require-yield
	static async *connect(_target, _incomingMessages, _request) {
		G.empty.opened++;
		try {
			// intentionally yields nothing
		} finally {
			G.empty.closed++;
		}
	}
}

// GET /SingleGen/ (Accept: text/event-stream) — exactly 1 event then completion.
export class SingleGen extends Resource {
	static loadAsInstance = false;
	static async *connect(_target, _incomingMessages, _request) {
		G.single.opened++;
		try {
			yield { n: 0 };
		} finally {
			G.single.closed++;
		}
	}
}

// GET /ThrowGen/ (Accept: text/event-stream) — yields 2 of an intended 5, then throws.
// This does NOT hit the fixed terminal-`done` code path (the iterator never reaches a
// `done:true` step — it rejects instead); it is the bounded-termination contrast arm next to
// the natural-completion cases.
export class ThrowGen extends Resource {
	static loadAsInstance = false;
	static async *connect(_target, _incomingMessages, _request) {
		G.throwGen.opened++;
		try {
			for (let i = 0; i < 5; i++) {
				if (i === 2) throw new Error('QA537-intentional-throw-partway');
				yield { n: i };
				await sleep(2);
			}
		} finally {
			G.throwGen.closed++;
		}
	}
}

// GET /LargeGen/ (Accept: text/event-stream) — 3000 events then completion. Larger finite
// stream exercising the same terminal-step path at volume (also a mild backpressure check).
export class LargeGen extends Resource {
	static loadAsInstance = false;
	static async *connect(_target, _incomingMessages, _request) {
		G.large.opened++;
		try {
			for (let i = 0; i < 3000; i++) {
				yield { n: i };
			}
		} finally {
			G.large.closed++;
		}
	}
}

// GET /Probe/ — readiness + lifecycle-counter snapshot (plain JSON, not SSE).
export class Probe extends Resource {
	static loadAsInstance = false;
	static async get() {
		return { ok: true, ...G };
	}
}
