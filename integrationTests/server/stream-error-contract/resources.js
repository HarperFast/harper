// QA-890 — does a pre-first-yield generator throw produce 0 bytes on the wire, or a proper
// status? Compares three streaming surfaces (SSE, NDJSON, plain iterable REST) across two
// throw points (pre-first-yield, mid-stream) on both the Node http server and uWS
// (HARPER_UWS_HTTP=1).
//
// SSE uses the subscription-style `static async *connect()` idiom (matches qa886's
// ThrowGenFirst/ThrowGen shape). NDJSON and "iterable REST" reuse the SAME underlying
// resources -- a plain `async get()` that returns an async generator object -- and are
// distinguished purely by the client's Accept header (application/x-ndjson vs
// application/json), since content negotiation picks the serializer, not the resource.

const G = (globalThis.__QA890__ ??= {
	ssePreYield: { opened: 0, closed: 0 },
	sseMidStream: { opened: 0, closed: 0 },
	sseHealth: { opened: 0, closed: 0 },
	iterPreYield: { opened: 0, closed: 0 },
	iterMidStream: { opened: 0, closed: 0 },
	iterHealth: { opened: 0, closed: 0 },
});

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// ── SSE surface (subscription-style connect()) ─────────────────────────────────────────────

// GET /SsePreYield/ (Accept: text/event-stream) — throws before yielding anything.
export class SsePreYield extends Resource {
	static loadAsInstance = false;
	static async *connect() {
		G.ssePreYield.opened++;
		try {
			throw new Error('QA890-sse-pre-yield');
			// eslint-disable-next-line no-unreachable
			yield { n: -1 };
		} finally {
			G.ssePreYield.closed++;
		}
	}
}

// GET /SseMidStream/ (Accept: text/event-stream) — yields 2 of 5, then throws.
export class SseMidStream extends Resource {
	static loadAsInstance = false;
	static async *connect() {
		G.sseMidStream.opened++;
		try {
			for (let i = 0; i < 5; i++) {
				if (i === 2) throw new Error('QA890-sse-mid-stream');
				yield { n: i };
				await sleep(2);
			}
		} finally {
			G.sseMidStream.closed++;
		}
	}
}

// GET /SseHealth/ (Accept: text/event-stream) — clean-completion control.
export class SseHealth extends Resource {
	static loadAsInstance = false;
	static async *connect() {
		G.sseHealth.opened++;
		try {
			for (let i = 0; i < 3; i++) {
				yield { n: i };
				await sleep(2);
			}
		} finally {
			G.sseHealth.closed++;
		}
	}
}

// ── NDJSON / plain-iterable REST surface (get() returns an async generator object) ─────────
// Content negotiation (Accept header) alone decides ndjson vs default-json array serialization
// -- same resource, same generator shape, only the client's Accept differs between the two axes.

// GET /IterPreYield/ — throws before yielding anything.
export class IterPreYield extends Resource {
	static loadAsInstance = false;
	async get() {
		G.iterPreYield.opened++;
		async function* gen() {
			try {
				throw new Error('QA890-iter-pre-yield');
				// eslint-disable-next-line no-unreachable
				yield { n: -1 };
			} finally {
				G.iterPreYield.closed++;
			}
		}
		return gen();
	}
}

// GET /IterMidStream/ — yields 2 of 5, then throws.
export class IterMidStream extends Resource {
	static loadAsInstance = false;
	async get() {
		G.iterMidStream.opened++;
		async function* gen() {
			try {
				for (let i = 0; i < 5; i++) {
					if (i === 2) throw new Error('QA890-iter-mid-stream');
					yield { n: i };
					await sleep(2);
				}
			} finally {
				G.iterMidStream.closed++;
			}
		}
		return gen();
	}
}

// GET /IterHealth/ — clean-completion control.
export class IterHealth extends Resource {
	static loadAsInstance = false;
	async get() {
		G.iterHealth.opened++;
		async function* gen() {
			try {
				for (let i = 0; i < 3; i++) {
					yield { n: i };
					await sleep(2);
				}
			} finally {
				G.iterHealth.closed++;
			}
		}
		return gen();
	}
}

// GET /Probe/ — readiness + lifecycle-counter snapshot (plain JSON, not a stream).
export class Probe extends Resource {
	static loadAsInstance = false;
	static async get() {
		return { ok: true, ...G };
	}
}
