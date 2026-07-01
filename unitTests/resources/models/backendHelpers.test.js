'use strict';

const assert = require('node:assert/strict');
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
