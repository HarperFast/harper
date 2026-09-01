// Fixture for sse-finite-generator.test.ts (QA-537 / #1628) — finite async generators streamed to
// completion over SSE, plus a rejecting contrast arm. The test file carries the bug recap.
//
// SSE requests reach these via `connect()`: server/REST.ts turns an `Accept: text/event-stream`
// GET into method CONNECT, which calls `resource.connect(...)`.

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

// GET /FiniteGen/ — canonical finite generator, N=5.
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

// GET /EmptyGen/ — 0 events, so the terminal `done` step is the very FIRST step produced.
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

// GET /SingleGen/ — exactly 1 event then completion.
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

// GET /ThrowGen/ — yields 2 of an intended 5, then throws. A rejecting iterator never reaches a
// `done:true` step, so this is the contrast arm rather than the fixed code path.
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

// GET /LargeGen/ — 3000 events then completion: the same terminal-step path at volume.
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
