// QA-702 — two-part exploratory probe: a companion to a JUST-SHIPPED fix, plus an OPEN sibling bug.
//
// (a) NOT a regression anchor for #1863 "fix: guard SSE writes against undefined event data
//     (#1724)" (commit 6bcd5cd29, merged into main 2026-07-21) -- that's
//     unitTests/server/serverHelpers/progressEmitter.test.js, which imports and calls the actual
//     fixed function directly. #1863's bug: server/serverHelpers/progressEmitter.ts's `writeSSE()`
//     used `JSON.stringify(event.data)` unconditionally for non-string `data`.
//     `JSON.stringify(undefined)` returns the *primitive* `undefined` (not a string), so
//     `.split(/\r?\n/)` on it threw a TypeError for any event carrying no payload; the fix is
//     `JSON.stringify(event.data) ?? ''`.
//
//     IMPORTANT SCOPE NOTE (found empirically, not assumed): `writeSSE()`/`createSSEResponseStream`
//     are wired up ONLY inside server/serverHelpers/serverHandlers.js for the operations-API
//     SSE_PROGRESS_OPERATIONS set (deploy_component / get_deployment / read_log) — none of which
//     let a test inject an arbitrary `data` value (their payloads are always real deployment/log
//     objects, never falsy). Attempting to import progressEmitter.ts directly into this fixture
//     to construct the exact call was tried and FAILS: jsResource components run from an isolated,
//     copied component root (`.../components/qa702-sse-event-data/resources.js`), not the live repo
//     checkout, so a relative `../../../server/...` import can't resolve there (confirmed via
//     `ResourceLoadError: Cannot find module '../../../server/serverHelpers/progressEmitter.ts'`
//     the first time this fixture was run) — a sandboxing boundary, not a bug.
//
//     So this fixture instead exercises the SIBLING SSE encoder that IS reachable by any Harper
//     Resource over `Accept: text/event-stream`: contentTypes.ts's `text/event-stream` media type
//     `serialize()`, invoked via `resource.connect()`. It's the client-visible "neighbour" of the
//     guarded path — same conceptual contract (turning a `{event, data}` message into SSE wire
//     bytes) — see the test file for the assertions this fixture backs.
//
// (b) Re-characterization of F-133 ("SSE hang on generator that throws mid-stream") on current
//     main: ThrowGen below is the same shape QA-537 used to document the (at the time) still-open
//     hang. Since QA-537 ran (SHA 31de6a3be), commits #1763/#1789 ("Fix SSE hang + uncaughtException
//     when a generator throws mid-stream") landed in server/http.ts's pipeBodyToResponse — wiring an
//     'error' listener on the streamed body so a source rejection propagates to the response
//     instead of becoming an unhandled 'error' event (Node uncaughtException) with the connection
//     left open. ThrowGen re-exercises that path on this SHA to confirm whether it's actually
//     fixed, changed shape, or still hangs.
//
// HealthGen + Probe are the liveness canary: a second clean SSE stream (and open/close counters)
// confirm the worker survived the throw case, not just that our own request didn't crash the test.

const G = (globalThis.__QA702__ ??= {
	throwGen: { opened: 0, closed: 0 },
	healthGen: { opened: 0, closed: 0 },
});

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// Build a single-shot SSE resource whose connect() yields exactly one `{event: 'payload', data}`
// message, then completes naturally (the terminal `done:true` step is passed through untransformed
// per the #1628/#1632 fix, so no extra SSE block follows).
function ssePayloadResource(data) {
	return class extends Resource {
		static loadAsInstance = false;
		static async *connect() {
			yield { event: 'payload', data };
		}
	};
}

// GET /UndefinedPayload/ (Accept: text/event-stream) — data: undefined.
export class UndefinedPayload extends ssePayloadResource(undefined) {}

// GET /NullPayload/ — data: null.
export class NullPayload extends ssePayloadResource(null) {}

// GET /EmptyStringPayload/ — data: ''.
export class EmptyStringPayload extends ssePayloadResource('') {}

// GET /ZeroPayload/ — data: 0.
export class ZeroPayload extends ssePayloadResource(0) {}

// GET /FalsePayload/ — data: false.
export class FalsePayload extends ssePayloadResource(false) {}

export class MultilineStringPayload extends ssePayloadResource('first line\nsecond line') {}

// GET /IdZeroPayload/ — a real `data` value paired with `id: 0`, a legitimate reconnect cursor.
export class IdZeroPayload extends Resource {
	static loadAsInstance = false;
	static async *connect() {
		yield { event: 'payload', data: 'id-zero-probe', id: 0 };
	}
}

// GET /RetryZeroPayload/ — a real `data` value paired with `retry: 0`.
export class RetryZeroPayload extends Resource {
	static loadAsInstance = false;
	static async *connect() {
		yield { event: 'payload', data: 'retry-zero-probe', retry: 0 };
	}
}

// GET /ZeroPayloadNoEvent/ — falsy `data` with no `event` key at all. Exercises the outer
// envelope-detection gate, distinct from the `hasData` matrix above which always sets
// `event: 'payload'` and so never reaches this gate via `data` alone.
export class ZeroPayloadNoEvent extends Resource {
	static loadAsInstance = false;
	static async *connect() {
		yield { data: 0 };
	}
}

// GET /DataKeyEnvelopePayload/ — a top-level data key always selects the SSE-envelope contract,
// so unrelated siblings are not serialized as literal payload fields.
export class DataKeyEnvelopePayload extends Resource {
	static loadAsInstance = false;
	static async *connect() {
		yield { data: 0, name: 'x' };
	}
}

// GET /IdKeyPlainObjectPayload/ — a plain data object with a top-level `id` key (e.g. a real
// database record) and no `data`/`event` key; must be JSON-wrapped wholesale, not misread as an
// SSE id.
export class IdKeyPlainObjectPayload extends Resource {
	static loadAsInstance = false;
	static async *connect() {
		yield { id: 42, name: 'Alice' };
	}
}

// GET /PlainObjectPayload/ — data: an object with no field literally named "data" inside it.
export class PlainObjectPayload extends ssePayloadResource({ foo: 'bar', n: 42 }) {}

// GET /NestedObjectPayload/ — data: a multi-level nested object/array structure.
export class NestedObjectPayload extends ssePayloadResource({
	phase: 'extract',
	detail: {
		steps: [
			{ name: 'a', status: 'ok' },
			{ name: 'b', status: 'ok' },
		],
		meta: { retries: 0, tags: ['x', 'y'] },
	},
}) {}

// GET /LargeStringPayload/ — data: a ~300KB string (no embedded newlines) to exercise the SSE
// write path's/PassThrough's backpressure handling at volume.
const LARGE_STRING = 'QA702-large-payload-'.repeat(15_000); // ~300,000 chars
export class LargeStringPayload extends ssePayloadResource(LARGE_STRING) {}

// GET /ThrowGen/ (Accept: text/event-stream) — F-133 re-characterization: a plain async
// generator that yields 2 of an intended 5 events, then throws. Bound by the client's own
// AbortController + timeout so a still-open regression surfaces as a caught timeout, not a
// hung test run.
export class ThrowGen extends Resource {
	static loadAsInstance = false;
	static async *connect() {
		G.throwGen.opened++;
		try {
			for (let i = 0; i < 5; i++) {
				if (i === 2) throw new Error('QA702-intentional-throw-partway');
				yield { n: i };
				await sleep(2);
			}
		} finally {
			G.throwGen.closed++;
		}
	}
}

// GET /HealthGen/ — a small finite generator used purely as a liveness canary after ThrowGen:
// if the worker survived (and isn't wedged), a fresh SSE request completes normally.
export class HealthGen extends Resource {
	static loadAsInstance = false;
	static async *connect() {
		G.healthGen.opened++;
		try {
			for (let i = 0; i < 3; i++) {
				yield { n: i };
				await sleep(2);
			}
		} finally {
			G.healthGen.closed++;
		}
	}
}

// GET /Probe/ — readiness + lifecycle-counter snapshot (plain JSON, not SSE) — also the plain
// GET-on-a-normal-route liveness check.
export class Probe extends Resource {
	static loadAsInstance = false;
	static async get() {
		return { ok: true, ...G };
	}
}
