'use strict';

/**
 * Unit tests for `resources/models/v1/chatCompletions.ts` (#631).
 *
 * Covers two adjudicated blockers on PR #1616:
 *  - REST.ts hands the handler `request.data`, which is an unawaited Promise for
 *    JSON bodies (server/REST.ts's streaming deserializer) — the handler must
 *    `await` it before reading any field, including `stream`.
 *  - Anonymous / non-super_user requests must be rejected with an OpenAI-shape
 *    401 / 403 envelope, mirroring Resource's default `allowRead`/`allowCreate`
 *    gate that static overrides bypass.
 */

const assert = require('node:assert');
require('#src/resources/databases');
const { setGenerative, clearRegistry } = require('#src/resources/models/backendRegistry');
const { TestBackend } = require('#src/resources/models/TestBackend');
const { V1ChatCompletions } = require('#src/resources/models/v1/chatCompletions');

const SUPER_USER = { role: { permission: { super_user: true } } };
const NON_SUPER_USER = { role: { permission: { super_user: false } } };

describe('V1ChatCompletions.post', () => {
	beforeEach(() => {
		setGenerative('default', new TestBackend());
	});

	afterEach(() => {
		clearRegistry();
	});

	it('returns a chat completion for a plain-object body (unit-test caller shape)', async () => {
		const body = { messages: [{ role: 'user', content: 'hi' }] };
		const result = await V1ChatCompletions.post(undefined, body, { user: SUPER_USER });
		assert.equal(result.object, 'chat.completion');
		assert.ok(result.choices[0].message.content.includes('hi'));
	});

	it('awaits a Promise-wrapped body, matching REST.ts passing request.data unawaited', async () => {
		const body = Promise.resolve({ messages: [{ role: 'user', content: 'hello' }] });
		const result = await V1ChatCompletions.post(undefined, body, { user: SUPER_USER });
		assert.equal(result.object, 'chat.completion');
		assert.ok(result.choices[0].message.content.includes('hello'));
	});

	it('reads the stream flag from a Promise-wrapped body', async () => {
		const body = Promise.resolve({ messages: [{ role: 'user', content: 'hi' }], stream: true });
		const result = await V1ChatCompletions.post(undefined, body, { user: SUPER_USER });
		assert.equal(result.status, 200);
		assert.equal(result.headers['Content-Type'], 'text/event-stream');
		assert.ok(result.body, 'expected a Readable body for the streaming path');
	});

	it('rejects an anonymous request with a 401 OpenAI-shape envelope', async () => {
		const body = { messages: [{ role: 'user', content: 'hi' }] };
		const result = await V1ChatCompletions.post(undefined, body, {});
		assert.equal(result.status, 401);
		assert.equal(result.data.error.type, 'authentication_error');
	});

	it('rejects a non-super_user request with a 403 OpenAI-shape envelope', async () => {
		const body = { messages: [{ role: 'user', content: 'hi' }] };
		const result = await V1ChatCompletions.post(undefined, body, { user: NON_SUPER_USER });
		assert.equal(result.status, 403);
		assert.equal(result.data.error.type, 'permission_error');
	});

	it('checks authorization before touching the body, even for a malformed body', async () => {
		const result = await V1ChatCompletions.post(undefined, 'not an object', {});
		assert.equal(result.status, 401, 'auth must be checked ahead of body validation');
	});

	// Malformed nested shapes must become OpenAI-shaped 400s, not TypeErrors escaping as 500s
	const malformed = {
		'a null message element': { messages: [null] },
		'a tool_calls entry with no function': {
			messages: [{ role: 'assistant', content: null, tool_calls: [{}] }],
		},
		'a tools entry with no function': { messages: [{ role: 'user', content: 'hi' }], tools: [{}] },
		'a non-array tools': { messages: [{ role: 'user', content: 'hi' }], tools: 'nope' },
	};
	for (const [label, body] of Object.entries(malformed)) {
		it(`returns a 400 OpenAI envelope for ${label}`, async () => {
			const result = await V1ChatCompletions.post(undefined, body, { user: SUPER_USER });
			assert.equal(result.status, 400, `expected 400 for ${label}`);
			assert.equal(result.data.error.type, 'invalid_request_error');
		});
	}

	it('returns a 400 when the body promise rejects (malformed JSON), not a 500', async () => {
		const result = await V1ChatCompletions.post(undefined, Promise.reject(new SyntaxError('Unexpected token')), {
			user: SUPER_USER,
		});
		assert.equal(result.status, 400);
		assert.equal(result.data.error.type, 'invalid_request_error');
	});

	it("rejects tool_choice 'required' rather than silently treating it as auto", async () => {
		const body = { messages: [{ role: 'user', content: 'hi' }], tool_choice: 'required' };
		const result = await V1ChatCompletions.post(undefined, body, { user: SUPER_USER });
		assert.equal(result.status, 400);
		assert.match(result.data.error.message, /tool_choice/);
	});

	/** Backend that records the exact input it was asked to generate from. */
	function recordingBackend(record) {
		return {
			name: 'recorder',
			capabilities: () => ({ embed: false, generate: true, stream: false, tools: true, adapters: false }),
			async generate(input) {
				record(input);
				return { status: 'completed', output: { content: 'ok', finishReason: 'stop' }, usage: {} };
			},
		};
	}

	it("omits tools entirely for tool_choice 'none' so the backend cannot return a tool call", async () => {
		let seen;
		setGenerative(
			'default',
			recordingBackend((i) => (seen = i))
		);
		const body = {
			messages: [{ role: 'user', content: 'hi' }],
			tool_choice: 'none',
			tools: [{ type: 'function', function: { name: 'get_weather' } }],
		};
		const result = await V1ChatCompletions.post(undefined, body, { user: SUPER_USER });
		assert.equal(result.object, 'chat.completion');
		// No tools → plain Message[] input rather than the { messages, tools } object form
		assert.ok(Array.isArray(seen), 'tools must not be forwarded when tool_choice is none');
	});

	it("still forwards tools for tool_choice 'auto'", async () => {
		let seen;
		setGenerative(
			'default',
			recordingBackend((i) => (seen = i))
		);
		const body = {
			messages: [{ role: 'user', content: 'hi' }],
			tool_choice: 'auto',
			tools: [{ type: 'function', function: { name: 'get_weather' } }],
		};
		await V1ChatCompletions.post(undefined, body, { user: SUPER_USER });
		assert.ok(!Array.isArray(seen) && seen.tools?.length === 1, 'tools should be offered for auto');
	});

	// A client sending an explicit `Accept: text/event-stream` is dispatched as CONNECT by
	// REST, which passes a null body — connect() must recover it from the request.
	it('connect() delegates to the same implementation, taking the body off the request', async () => {
		const body = { messages: [{ role: 'user', content: 'hi' }] };
		const result = await V1ChatCompletions.connect(undefined, null, { user: SUPER_USER, data: body });
		assert.equal(result.object, 'chat.completion');
	});

	it('connect() applies the same auth gate', async () => {
		const result = await V1ChatCompletions.connect(undefined, null, { data: { messages: [] } });
		assert.equal(result.status, 401);
	});
});
