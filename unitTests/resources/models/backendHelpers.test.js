'use strict';

const assert = require('node:assert');
const {
	composeSignal,
	assignFiniteTokenCount,
	parseJsonResponse,
	readBoundedJson,
	MAX_RESPONSE_BODY_BYTES,
	MAX_ERROR_BODY_BYTES,
	requireModel,
	requireCredential,
	normalizeOrigin,
	DEFAULT_MAX_RETRIES,
	DEFAULT_RETRY_BACKOFF_MS,
	MAX_RETRY_DELAY_MS,
	MAX_RETRY_AFTER_MS,
	resolveRetryConfig,
	isRetriableStatus,
	parseRetryAfterMs,
	computeRetryDelayMs,
	abortableSleep,
	fetchWithRetry,
} = require('#src/resources/models/backendHelpers');

// Backend-specific error class used to verify the helpers route the thrown
// error through the caller's constructor, not a generic `Error`.
class FakeBackendError extends Error {
	constructor(message) {
		super(message);
		this.name = 'FakeBackendError';
	}
}

describe('backendHelpers', () => {
	describe('composeSignal', () => {
		it('returns undefined when neither input is provided', () => {
			assert.strictEqual(composeSignal(undefined, undefined), undefined);
		});

		it('returns the caller signal unchanged when no timeout', () => {
			const ctrl = new AbortController();
			assert.strictEqual(composeSignal(ctrl.signal, undefined), ctrl.signal);
		});

		it('returns a timeout-only signal when caller is undefined', () => {
			const s = composeSignal(undefined, 5000);
			assert.ok(s instanceof AbortSignal);
		});

		it('composes both inputs via AbortSignal.any', () => {
			const ctrl = new AbortController();
			const s = composeSignal(ctrl.signal, 5000);
			assert.ok(s instanceof AbortSignal);
			assert.notStrictEqual(s, ctrl.signal); // distinct composed signal
		});

		it('composed signal aborts when caller aborts', async () => {
			const ctrl = new AbortController();
			const s = composeSignal(ctrl.signal, 60_000);
			let fired = false;
			s.addEventListener('abort', () => {
				fired = true;
			});
			ctrl.abort();
			// abort listeners fire synchronously
			assert.strictEqual(fired, true);
		});
	});

	describe('assignFiniteTokenCount', () => {
		it('assigns a positive integer', () => {
			const usage = {};
			assignFiniteTokenCount(usage, 'promptTokens', 7);
			assert.strictEqual(usage.promptTokens, 7);
		});

		it('assigns 0', () => {
			const usage = {};
			assignFiniteTokenCount(usage, 'completionTokens', 0);
			assert.strictEqual(usage.completionTokens, 0);
		});

		it('drops NaN', () => {
			const usage = {};
			assignFiniteTokenCount(usage, 'promptTokens', NaN);
			assert.strictEqual(usage.promptTokens, undefined);
		});

		it('drops Infinity', () => {
			const usage = {};
			assignFiniteTokenCount(usage, 'promptTokens', Infinity);
			assert.strictEqual(usage.promptTokens, undefined);
		});

		it('drops negatives', () => {
			const usage = {};
			assignFiniteTokenCount(usage, 'promptTokens', -1);
			assert.strictEqual(usage.promptTokens, undefined);
		});

		it('drops non-integer floats', () => {
			const usage = {};
			assignFiniteTokenCount(usage, 'promptTokens', 1.5);
			assert.strictEqual(usage.promptTokens, undefined);
		});

		it('drops non-number values', () => {
			const usage = {};
			assignFiniteTokenCount(usage, 'promptTokens', '7');
			assert.strictEqual(usage.promptTokens, undefined);
			assignFiniteTokenCount(usage, 'promptTokens', null);
			assert.strictEqual(usage.promptTokens, undefined);
			assignFiniteTokenCount(usage, 'promptTokens', undefined);
			assert.strictEqual(usage.promptTokens, undefined);
		});
	});

	describe('parseJsonResponse', () => {
		it('returns the parsed body on success', async () => {
			const res = new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
			const body = await parseJsonResponse(res, '/test', FakeBackendError);
			assert.deepStrictEqual(body, { ok: true });
		});

		it('throws the supplied error class on invalid JSON', async () => {
			const res = new Response('<html>oops</html>', { status: 200 });
			await assert.rejects(() => parseJsonResponse(res, '/test', FakeBackendError), FakeBackendError);
		});

		it('error message includes the endpoint path (not raw upstream bytes)', async () => {
			const res = new Response('<script>alert(1)</script>', { status: 200 });
			try {
				await parseJsonResponse(res, '/api/embed', FakeBackendError);
				assert.fail('expected throw');
			} catch (err) {
				assert.ok(err.message.includes('/api/embed'));
				assert.ok(!err.message.includes('<script>'));
			}
		});
	});

	describe('requireModel', () => {
		it('passes when model is a non-empty string', () => {
			requireModel('gpt-4o', 'generate', FakeBackendError); // does not throw
		});

		it('throws when model is undefined', () => {
			assert.throws(() => requireModel(undefined, 'embed', FakeBackendError), FakeBackendError);
		});

		it('throws when model is empty string', () => {
			assert.throws(() => requireModel('', 'generate', FakeBackendError), FakeBackendError);
		});

		it('error message names the operation', () => {
			try {
				requireModel(undefined, 'generateStream', FakeBackendError);
				assert.fail('expected throw');
			} catch (err) {
				assert.ok(err.message.includes('generateStream'));
			}
		});
	});

	describe('requireCredential', () => {
		it('returns the value when non-empty and not a placeholder', () => {
			const v = requireCredential('sk-real', 'OpenAI', 'apiKey', FakeBackendError);
			assert.strictEqual(v, 'sk-real');
		});

		it('throws when undefined', () => {
			assert.throws(
				() => requireCredential(undefined, 'OpenAI', 'apiKey', FakeBackendError),
				/OpenAI backend requires apiKey/
			);
		});

		it('throws when empty string', () => {
			assert.throws(
				() => requireCredential('', 'Anthropic', 'apiKey', FakeBackendError),
				/Anthropic backend requires apiKey/
			);
		});

		it('throws when value is an unresolved ${VAR} placeholder', () => {
			assert.throws(
				() => requireCredential('${SOMETHING_UNSET}', 'OpenAI', 'apiKey', FakeBackendError),
				/literal placeholder/
			);
		});

		it('error message echoes the placeholder string (env var name is not sensitive)', () => {
			try {
				requireCredential('${UNSET_FOR_TEST}', 'Anthropic', 'apiKey', FakeBackendError);
				assert.fail('expected throw');
			} catch (err) {
				assert.ok(err.message.includes('${UNSET_FOR_TEST}'));
			}
		});
	});

	describe('normalizeOrigin', () => {
		it('defaults to the configured host when value is empty', () => {
			assert.strictEqual(
				normalizeOrigin(undefined, { host: 'localhost:11434', secure: false }),
				'http://localhost:11434'
			);
		});

		it('uses https scheme when defaults.secure is true', () => {
			assert.strictEqual(
				normalizeOrigin(undefined, { host: 'api.openai.com/v1', secure: true }),
				'https://api.openai.com/v1'
			);
		});

		it('respects an explicit http:// scheme on the value', () => {
			assert.strictEqual(
				normalizeOrigin('http://my-local', { host: 'localhost:11434', secure: false }),
				'http://my-local'
			);
		});

		it('respects an explicit https:// scheme on the value', () => {
			assert.strictEqual(
				normalizeOrigin('https://my-azure.openai.azure.com/openai/v1', {
					host: 'api.openai.com/v1',
					secure: true,
				}),
				'https://my-azure.openai.azure.com/openai/v1'
			);
		});

		it('strips trailing slashes', () => {
			assert.strictEqual(
				normalizeOrigin('https://api.openai.com/v1/', { host: 'x', secure: true }),
				'https://api.openai.com/v1'
			);
			assert.strictEqual(normalizeOrigin('localhost:11434///', { host: 'x', secure: false }), 'http://localhost:11434');
		});

		it('trims whitespace from the value', () => {
			assert.strictEqual(
				normalizeOrigin('  localhost:11434  ', { host: 'x', secure: false }),
				'http://localhost:11434'
			);
		});
	});
});

// ---- finding 5a: bounded body reader -------------------------------------------

/**
 * Build a Response whose body is a ReadableStream that emits the given Uint8Array
 * chunks in order. This exercises the streaming read path in readBoundedJson.
 */
function streamedResponse(chunks, { status = 200 } = {}) {
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	return new Response(stream, { status, headers: { 'Content-Type': 'application/json' } });
}

const enc = new TextEncoder();

describe('readBoundedJson', () => {
	it('parses a normal JSON body under the cap', async () => {
		const res = streamedResponse([enc.encode(JSON.stringify({ value: 42 }))]);
		const body = await readBoundedJson(res, '/test', FakeBackendError, MAX_RESPONSE_BODY_BYTES);
		assert.deepStrictEqual(body, { value: 42 });
	});

	it('parses a body split across multiple chunks', async () => {
		const payload = JSON.stringify({ hello: 'world' });
		// Split at byte 4 to ensure multi-chunk merge works.
		const a = enc.encode(payload.slice(0, 4));
		const b = enc.encode(payload.slice(4));
		const res = streamedResponse([a, b]);
		const result = await readBoundedJson(res, '/api', FakeBackendError, MAX_RESPONSE_BODY_BYTES);
		assert.deepStrictEqual(result, { hello: 'world' });
	});

	it('throws the backend error class when the body exceeds maxBytes', async () => {
		// Build a body that is 3 bytes over a 10-byte cap.
		const big = enc.encode('x'.repeat(13));
		const res = streamedResponse([big]);
		await assert.rejects(
			() => readBoundedJson(res, '/big', FakeBackendError, 10),
			(err) => {
				assert.ok(err instanceof FakeBackendError);
				assert.ok(err.message.includes('/big'), 'error should name the endpoint');
				return true;
			}
		);
	});

	it('throws the backend error class on invalid JSON (not a raw SyntaxError)', async () => {
		const res = streamedResponse([enc.encode('not-valid-json')]);
		await assert.rejects(
			() => readBoundedJson(res, '/parse', FakeBackendError, MAX_RESPONSE_BODY_BYTES),
			(err) => {
				assert.ok(err instanceof FakeBackendError);
				return true;
			}
		);
	});

	it('throws the backend error class when the response has no body', async () => {
		// Response with null body (e.g. HEAD response or server returning no content).
		const res = new Response(null, { status: 200 });
		await assert.rejects(
			() => readBoundedJson(res, '/nobody', FakeBackendError, MAX_RESPONSE_BODY_BYTES),
			FakeBackendError
		);
	});

	it('parseJsonResponse uses the 256 MiB success-body cap', () => {
		// Raised from 64 MiB to 256 MiB to accommodate large OpenAI embedding batch responses (125–190 MiB JSON).
		assert.strictEqual(MAX_RESPONSE_BODY_BYTES, 256 * 1024 * 1024);
	});

	it('MAX_ERROR_BODY_BYTES is 256 KiB', () => {
		assert.strictEqual(MAX_ERROR_BODY_BYTES, 256 * 1024);
	});
});

describe('backendHelpers retry (#1594)', () => {
	// Records requested sleep durations without actually sleeping — keeps the
	// backoff paths deterministic and instant.
	function sleepRecorder() {
		const sleeps = [];
		return {
			sleeps,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		};
	}

	function retryOpts(overrides = {}) {
		return { maxRetries: 2, retryBackoffMs: 500, random: () => 0, ...overrides };
	}

	describe('resolveRetryConfig', () => {
		it('falls back to defaults on an empty config', () => {
			assert.deepStrictEqual(resolveRetryConfig({}), {
				maxRetries: DEFAULT_MAX_RETRIES,
				retryBackoffMs: DEFAULT_RETRY_BACKOFF_MS,
			});
		});

		it('respects an explicit maxRetries of 0', () => {
			assert.strictEqual(resolveRetryConfig({ maxRetries: 0 }).maxRetries, 0);
		});

		it('passes through valid values', () => {
			assert.deepStrictEqual(resolveRetryConfig({ maxRetries: 5, retryBackoffMs: 100 }), {
				maxRetries: 5,
				retryBackoffMs: 100,
			});
		});

		it('rejects malformed values back to defaults', () => {
			for (const maxRetries of [-1, 1.5, NaN, Infinity, '2']) {
				assert.strictEqual(resolveRetryConfig({ maxRetries }).maxRetries, DEFAULT_MAX_RETRIES);
			}
			for (const retryBackoffMs of [0, -100, NaN, Infinity, '500']) {
				assert.strictEqual(resolveRetryConfig({ retryBackoffMs }).retryBackoffMs, DEFAULT_RETRY_BACKOFF_MS);
			}
		});
	});

	describe('isRetriableStatus', () => {
		it('retries timeout, rate limit, and server errors', () => {
			for (const status of [408, 429, 500, 502, 503, 504, 529, 599]) {
				assert.strictEqual(isRetriableStatus(status), true, `expected ${status} retriable`);
			}
		});

		it('does not retry deterministic client errors or success', () => {
			for (const status of [200, 201, 301, 400, 401, 403, 404, 409, 422]) {
				assert.strictEqual(isRetriableStatus(status), false, `expected ${status} non-retriable`);
			}
		});
	});

	describe('parseRetryAfterMs', () => {
		it('parses delta-seconds', () => {
			assert.strictEqual(parseRetryAfterMs('2'), 2000);
			assert.strictEqual(parseRetryAfterMs('0'), 0);
		});

		it('parses an HTTP-date into a forward delay', () => {
			const ms = parseRetryAfterMs(new Date(Date.now() + 5000).toUTCString());
			assert.ok(ms > 0 && ms <= 5000, `expected 0 < ms <= 5000, got ${ms}`);
		});

		it('clamps a past HTTP-date to 0', () => {
			assert.strictEqual(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString()), 0);
		});

		it('returns undefined for absent, negative, or garbage values', () => {
			assert.strictEqual(parseRetryAfterMs(null), undefined);
			assert.strictEqual(parseRetryAfterMs('-5'), undefined);
			assert.strictEqual(parseRetryAfterMs('soon'), undefined);
		});
	});

	describe('computeRetryDelayMs', () => {
		it('doubles per attempt with the jitter floor at half the exponential', () => {
			assert.strictEqual(
				computeRetryDelayMs(0, 500, () => 0),
				250
			);
			assert.strictEqual(
				computeRetryDelayMs(1, 500, () => 0),
				500
			);
			assert.strictEqual(
				computeRetryDelayMs(2, 500, () => 0),
				1000
			);
		});

		it('never exceeds the exponential value', () => {
			const delay = computeRetryDelayMs(1, 500, () => 0.999999);
			assert.ok(delay < 1000, `expected < 1000, got ${delay}`);
		});

		it('caps the exponential at MAX_RETRY_DELAY_MS', () => {
			const delay = computeRetryDelayMs(30, 500, () => 0.999999);
			assert.ok(delay <= MAX_RETRY_DELAY_MS, `expected <= ${MAX_RETRY_DELAY_MS}, got ${delay}`);
		});
	});

	describe('abortableSleep', () => {
		it('resolves after the given duration', async () => {
			await abortableSleep(5);
		});

		it('rejects with the abort reason when the signal fires mid-sleep', async () => {
			const ctrl = new AbortController();
			const reason = new Error('deadline');
			setTimeout(() => ctrl.abort(reason), 5);
			await assert.rejects(abortableSleep(60_000, ctrl.signal), (err) => err === reason);
		});

		it('rejects immediately on an already-aborted signal', async () => {
			const ctrl = new AbortController();
			ctrl.abort();
			await assert.rejects(abortableSleep(60_000, ctrl.signal));
		});
	});

	describe('fetchWithRetry', () => {
		function mockFetch(responders) {
			const calls = [];
			const fn = async (url, init) => {
				calls.push({ url, init });
				const responder = responders[Math.min(calls.length - 1, responders.length - 1)];
				if (responder instanceof Error) throw responder;
				return responder();
			};
			fn.calls = calls;
			return fn;
		}

		it('retries a retriable status and returns the eventual success', async () => {
			const { sleeps, sleep } = sleepRecorder();
			const fetchImpl = mockFetch([() => new Response('', { status: 503 }), () => new Response('ok', { status: 200 })]);
			const res = await fetchWithRetry(fetchImpl, 'http://u', {}, retryOpts({ sleep }));
			assert.strictEqual(res.status, 200);
			assert.strictEqual(fetchImpl.calls.length, 2);
			assert.deepStrictEqual(sleeps, [250]); // 500 * 2^0 * 0.5 (random pinned to 0)
		});

		it('honors Retry-After delta-seconds over the computed backoff', async () => {
			const { sleeps, sleep } = sleepRecorder();
			const fetchImpl = mockFetch([
				() => new Response('', { status: 429, headers: { 'retry-after': '1' } }),
				() => new Response('ok', { status: 200 }),
			]);
			const res = await fetchWithRetry(fetchImpl, 'http://u', {}, retryOpts({ sleep }));
			assert.strictEqual(res.status, 200);
			assert.deepStrictEqual(sleeps, [1000]);
		});

		it('surfaces the response instead of honoring a Retry-After beyond the cap', async () => {
			const { sleeps, sleep } = sleepRecorder();
			const fetchImpl = mockFetch([
				() => new Response('', { status: 429, headers: { 'retry-after': String(MAX_RETRY_AFTER_MS / 1000 + 1) } }),
			]);
			const res = await fetchWithRetry(fetchImpl, 'http://u', {}, retryOpts({ sleep }));
			assert.strictEqual(res.status, 429);
			assert.strictEqual(fetchImpl.calls.length, 1);
			assert.deepStrictEqual(sleeps, []);
		});

		it('does not retry a non-retriable status', async () => {
			const { sleeps, sleep } = sleepRecorder();
			const fetchImpl = mockFetch([() => new Response('', { status: 400 })]);
			const res = await fetchWithRetry(fetchImpl, 'http://u', {}, retryOpts({ sleep }));
			assert.strictEqual(res.status, 400);
			assert.strictEqual(fetchImpl.calls.length, 1);
			assert.deepStrictEqual(sleeps, []);
		});

		it('returns the final retriable response once maxRetries is exhausted', async () => {
			const { sleeps, sleep } = sleepRecorder();
			const fetchImpl = mockFetch([() => new Response('', { status: 503 })]);
			const res = await fetchWithRetry(fetchImpl, 'http://u', {}, retryOpts({ sleep }));
			assert.strictEqual(res.status, 503);
			assert.strictEqual(fetchImpl.calls.length, 3); // initial + 2 retries
			assert.deepStrictEqual(sleeps, [250, 500]);
		});

		it('makes a single attempt when maxRetries is 0', async () => {
			const fetchImpl = mockFetch([() => new Response('', { status: 503 })]);
			const res = await fetchWithRetry(fetchImpl, 'http://u', {}, retryOpts({ maxRetries: 0 }));
			assert.strictEqual(res.status, 503);
			assert.strictEqual(fetchImpl.calls.length, 1);
		});

		it('retries a transient network rejection', async () => {
			const { sleep } = sleepRecorder();
			const fetchImpl = mockFetch([new TypeError('fetch failed'), () => new Response('ok', { status: 200 })]);
			const res = await fetchWithRetry(fetchImpl, 'http://u', {}, retryOpts({ sleep }));
			assert.strictEqual(res.status, 200);
			assert.strictEqual(fetchImpl.calls.length, 2);
		});

		it('rethrows the network error once maxRetries is exhausted', async () => {
			const { sleep } = sleepRecorder();
			const boom = new TypeError('fetch failed');
			const fetchImpl = mockFetch([boom]);
			await assert.rejects(fetchWithRetry(fetchImpl, 'http://u', {}, retryOpts({ maxRetries: 1, sleep })), boom);
			assert.strictEqual(fetchImpl.calls.length, 2);
		});

		it('never retries an abort', async () => {
			const { sleep } = sleepRecorder();
			const fetchImpl = mockFetch([new DOMException('This operation was aborted', 'AbortError')]);
			await assert.rejects(fetchWithRetry(fetchImpl, 'http://u', {}, retryOpts({ sleep })), /aborted/i);
			assert.strictEqual(fetchImpl.calls.length, 1);
		});

		it('never retries a timeout abort', async () => {
			const { sleep } = sleepRecorder();
			const fetchImpl = mockFetch([new DOMException('The operation timed out', 'TimeoutError')]);
			await assert.rejects(fetchWithRetry(fetchImpl, 'http://u', {}, retryOpts({ sleep })), /timed out/i);
			assert.strictEqual(fetchImpl.calls.length, 1);
		});

		it('a signal abort during backoff stops the retry loop promptly', async () => {
			const ctrl = new AbortController();
			const reason = new Error('caller gave up');
			const fetchImpl = mockFetch([
				() => {
					setTimeout(() => ctrl.abort(reason), 5);
					return new Response('', { status: 503 });
				},
			]);
			// Real abortableSleep + a long backoff: only the abort can end the test quickly.
			await assert.rejects(
				fetchWithRetry(fetchImpl, 'http://u', { signal: ctrl.signal }, retryOpts({ retryBackoffMs: 60_000 })),
				(err) => err === reason
			);
			assert.strictEqual(fetchImpl.calls.length, 1);
		});
	});
});
