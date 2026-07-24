'use strict';

/**
 * Unit tests for `resources/models/v1/embeddings.ts` (#631).
 *
 * Covers two adjudicated blockers on PR #1616:
 *  - REST.ts hands the handler `request.data`, which is an unawaited Promise for
 *    JSON bodies — the handler must `await` it before reading any field.
 *  - Anonymous / non-super_user requests must be rejected with an OpenAI-shape
 *    401 / 403 envelope, mirroring Resource's default `allowRead`/`allowCreate`
 *    gate that static overrides bypass.
 */

const assert = require('node:assert');
require('#src/resources/databases');
const { setEmbedding, clearRegistry } = require('#src/resources/models/backendRegistry');
const { TestBackend } = require('#src/resources/models/TestBackend');
const { V1Embeddings } = require('#src/resources/models/v1/embeddings');

const SUPER_USER = { role: { permission: { super_user: true } } };
const NON_SUPER_USER = { role: { permission: { super_user: false } } };

describe('V1Embeddings.post', () => {
	beforeEach(() => {
		setEmbedding('default', new TestBackend());
	});

	afterEach(() => {
		clearRegistry();
	});

	it('returns embeddings for a plain-object body (unit-test caller shape)', async () => {
		const body = { input: 'hello world' };
		const result = await V1Embeddings.post(undefined, body, { user: SUPER_USER });
		assert.equal(result.object, 'list');
		assert.equal(result.data.length, 1);
	});

	it('awaits a Promise-wrapped body, matching REST.ts passing request.data unawaited', async () => {
		const body = Promise.resolve({ input: ['a', 'b'] });
		const result = await V1Embeddings.post(undefined, body, { user: SUPER_USER });
		assert.equal(result.object, 'list');
		assert.equal(result.data.length, 2);
	});

	it('rejects an anonymous request with a 401 OpenAI-shape envelope', async () => {
		const body = { input: 'hello' };
		const result = await V1Embeddings.post(undefined, body, {});
		assert.equal(result.status, 401);
		assert.equal(result.data.error.type, 'authentication_error');
	});

	it('rejects a non-super_user request with a 403 OpenAI-shape envelope', async () => {
		const body = { input: 'hello' };
		const result = await V1Embeddings.post(undefined, body, { user: NON_SUPER_USER });
		assert.equal(result.status, 403);
		assert.equal(result.data.error.type, 'permission_error');
	});

	it('checks authorization before touching the body, even for a malformed body', async () => {
		const result = await V1Embeddings.post(undefined, 'not an object', {});
		assert.equal(result.status, 401, 'auth must be checked ahead of body validation');
	});

	it("returns base64 string embeddings for encoding_format: 'base64'", async () => {
		const body = { input: 'hello', encoding_format: 'base64' };
		const result = await V1Embeddings.post(undefined, body, { user: SUPER_USER });
		assert.equal(result.object, 'list');
		assert.equal(typeof result.data[0].embedding, 'string');
		const buf = Buffer.from(result.data[0].embedding, 'base64');
		assert.equal(buf.byteLength % 4, 0, 'expected float32-aligned bytes');
	});

	it("accepts an explicit encoding_format: 'float'", async () => {
		const body = { input: 'hello', encoding_format: 'float' };
		const result = await V1Embeddings.post(undefined, body, { user: SUPER_USER });
		assert.ok(Array.isArray(result.data[0].embedding));
	});

	it('rejects an unknown encoding_format with a 400 OpenAI-shape envelope', async () => {
		const body = { input: 'hello', encoding_format: 'int8' };
		const result = await V1Embeddings.post(undefined, body, { user: SUPER_USER });
		assert.equal(result.status, 400);
		assert.equal(result.data.error.type, 'invalid_request_error');
	});

	it('accepts a batch at the 2048-item cap', async () => {
		const body = { input: Array.from({ length: 2048 }, (_, i) => `item ${i}`) };
		const result = await V1Embeddings.post(undefined, body, { user: SUPER_USER });
		assert.equal(result.object, 'list');
		assert.equal(result.data.length, 2048);
	});

	it('rejects a batch over the 2048-item cap with a 400 OpenAI-shape envelope', async () => {
		const body = { input: Array.from({ length: 2049 }, (_, i) => `item ${i}`) };
		const result = await V1Embeddings.post(undefined, body, { user: SUPER_USER });
		assert.equal(result.status, 400);
		assert.equal(result.data.error.type, 'invalid_request_error');
	});
});
