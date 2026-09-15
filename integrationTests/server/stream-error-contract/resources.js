// QA-890 compares three streaming surfaces (SSE, NDJSON, plain iterable REST) across
// immediate, delayed, and mid-stream throws on both the Node http server and uWS
// (HARPER_UWS_HTTP=1).
//
// SSE uses the subscription-style `static async *connect()` idiom (matches qa886's
// ThrowGenFirst/ThrowGen shape). NDJSON and "iterable REST" reuse the SAME underlying
// resources -- a plain `async get()` that returns an async generator object -- and are
// distinguished purely by the client's Accept header (application/x-ndjson vs
// application/json), since content negotiation picks the serializer, not the resource.

const G = (globalThis.__QA890__ ??= {
	ssePreYield: { opened: 0, closed: 0 },
	sseDelayedError: { opened: 0, closed: 0 },
	sseMidStream: { opened: 0, closed: 0 },
	sseHealth: { opened: 0, closed: 0 },
	iterPreYield: { opened: 0, closed: 0 },
	iterDelayedError: { opened: 0, closed: 0 },
	iterMidStream: { opened: 0, closed: 0 },
	iterHealth: { opened: 0, closed: 0 },
	envelopeHead: { opened: 0, closed: 0 },
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
			yield* [];
			throw new Error('QA890-sse-pre-yield');
		} finally {
			G.ssePreYield.closed++;
		}
	}
}

export class SseDelayedError extends Resource {
	static loadAsInstance = false;
	static async *connect() {
		G.sseDelayedError.opened++;
		try {
			await sleep(20);
			yield* [];
			throw new Error('QA890-sse-delayed-error');
		} finally {
			G.sseDelayedError.closed++;
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
		async function* gen() {
			G.iterPreYield.opened++;
			try {
				yield* [];
				throw new Error('QA890-iter-pre-yield');
			} finally {
				G.iterPreYield.closed++;
			}
		}
		return gen();
	}
}

export class IterDelayedError extends Resource {
	static loadAsInstance = false;
	async get() {
		async function* gen() {
			G.iterDelayedError.opened++;
			try {
				await sleep(20);
				yield* [];
				throw new Error('QA890-iter-delayed-error');
			} finally {
				G.iterDelayedError.closed++;
			}
		}
		return gen();
	}
}

// GET /IterMidStream/ — yields 2 of 5, then throws.
export class IterMidStream extends Resource {
	static loadAsInstance = false;
	async get() {
		async function* gen() {
			G.iterMidStream.opened++;
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
		async function* gen() {
			G.iterHealth.opened++;
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

// This response-like envelope keeps lifecycle counters inside the generator so the HEAD test can
// distinguish constructing the envelope from entering and closing its streaming body.
export class EnvelopeHead extends Resource {
	static loadAsInstance = false;
	async get() {
		async function* gen() {
			G.envelopeHead.opened++;
			try {
				yield { n: 0 };
			} finally {
				G.envelopeHead.closed++;
			}
		}
		return { status: 200, headers: {}, data: gen() };
	}
}

// GET /Probe/ — readiness + lifecycle-counter snapshot (plain JSON, not a stream).
export class Probe extends Resource {
	static loadAsInstance = false;
	static async get() {
		return { ok: true, ...G };
	}
}
