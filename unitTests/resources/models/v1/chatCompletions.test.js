'use strict';

/**
 * Unit tests for `resources/models/v1/chatCompletions.ts` (#631).
 *
 * REST.ts hands the handler `request.data`, which is an unawaited Promise for
 * JSON bodies (server/REST.ts's streaming deserializer) — the handler must
 * `await` it before reading any field, including `stream`.
 */

const assert = require('node:assert');
require('#src/resources/databases');
const { setGenerative, clearRegistry } = require('#src/resources/models/backendRegistry');
const { TestBackend } = require('#src/resources/models/TestBackend');
const { V1ChatCompletions } = require('#src/resources/models/v1/chatCompletions');

describe('V1ChatCompletions.post', () => {
	beforeEach(() => {
		setGenerative('default', new TestBackend());
	});

	afterEach(() => {
		clearRegistry();
	});

	it('returns a chat completion for a plain-object body (unit-test caller shape)', async () => {
		const body = { messages: [{ role: 'user', content: 'hi' }] };
		const result = await V1ChatCompletions.post(undefined, body, {});
		assert.equal(result.object, 'chat.completion');
		assert.ok(result.choices[0].message.content.includes('hi'));
	});

	it('awaits a Promise-wrapped body, matching REST.ts passing request.data unawaited', async () => {
		const body = Promise.resolve({ messages: [{ role: 'user', content: 'hello' }] });
		const result = await V1ChatCompletions.post(undefined, body, {});
		assert.equal(result.object, 'chat.completion');
		assert.ok(result.choices[0].message.content.includes('hello'));
	});

	it('reads the stream flag from a Promise-wrapped body', async () => {
		const body = Promise.resolve({ messages: [{ role: 'user', content: 'hi' }], stream: true });
		const result = await V1ChatCompletions.post(undefined, body, {});
		assert.equal(result.status, 200);
		assert.equal(result.headers['Content-Type'], 'text/event-stream');
		assert.ok(result.body, 'expected a Readable body for the streaming path');
	});
});
