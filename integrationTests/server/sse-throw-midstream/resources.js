// QA-559 — regression verify for #1789 ("Fix SSE hang + uncaughtException when a generator
// throws mid-stream", commit 8930b1ef2).
//
// Bug recap: server/http.ts's plain Node HTTP requestHandler piped a streaming response body
// with `body.pipe(nodeResponse)` but never attached an 'error' listener on the source. pipe()
// doesn't forward source 'error' events to the destination, and an unhandled 'error' on an
// EventEmitter is a Node uncaughtException -- contentTypes.ts's serializeStream()/Readable.from
// already surfaced the generator's rejection correctly, it just had no listener downstream. The
// fix extracts an exported `pipeBodyToResponse` helper that wires the pipe via `stream.pipeline`,
// which tears down both sides (including closing the response, abruptly rather than cleanly) on
// a source error instead of leaving it hanging / crashing the process.
//
// This fixture exercises multiple throw-timing shapes over SSE (dispatched via
// `resource.connect()`, which is what Harper's REST layer invokes for CONNECT/SSE requests --
// see server/REST.ts: `isSse` sets method to 'CONNECT', which calls `resource.connect(...)`):
//   ThrowFirst - throws on the very first step, before any event is yielded.
//   ThrowMid   - yields 3 of an intended 6 events, then throws (genuine mid-stream failure).
//   CleanGen   - control: 5 events then a bare `return` (natural completion, no throw).
//   Probe      - readiness + per-resource open/close lifecycle counters, plain JSON.

const G = (globalThis.__QA559__ ??= {
	throwFirst: { opened: 0, closed: 0 },
	throwMid: { opened: 0, closed: 0 },
	clean: { opened: 0, closed: 0 },
});

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// GET /ThrowFirst/ (Accept: text/event-stream) — throws on the very first step, before any
// bytes are yielded. Exercises the throw-before-any-yield edge of the fix.
export class ThrowFirst extends Resource {
	static loadAsInstance = false;
	static async *connect(_target, _incomingMessages, _request) {
		G.throwFirst.opened++;
		try {
			throw new Error('QA559-intentional-throw-first');
			// eslint-disable-next-line no-unreachable
			yield { n: 0 };
		} finally {
			G.throwFirst.closed++;
		}
	}
}

// GET /ThrowMid/ (Accept: text/event-stream) — yields 3 of an intended 6 events, then throws.
// Genuine mid-stream failure: some bytes already flushed to the client before the error.
export class ThrowMid extends Resource {
	static loadAsInstance = false;
	static async *connect(_target, _incomingMessages, _request) {
		G.throwMid.opened++;
		try {
			for (let i = 0; i < 6; i++) {
				if (i === 3) throw new Error('QA559-intentional-throw-mid');
				yield { n: i };
				await sleep(2);
			}
		} finally {
			G.throwMid.closed++;
		}
	}
}

// GET /CleanGen/ (Accept: text/event-stream) — control case: 5 events then natural completion,
// no throw. Must still deliver exactly the right event count and close cleanly.
export class CleanGen extends Resource {
	static loadAsInstance = false;
	static async *connect(_target, _incomingMessages, _request) {
		G.clean.opened++;
		try {
			for (let i = 0; i < 5; i++) {
				yield { n: i };
				await sleep(2);
			}
		} finally {
			G.clean.closed++;
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
