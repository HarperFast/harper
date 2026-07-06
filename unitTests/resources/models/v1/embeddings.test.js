'use strict';

/**
 * Unit tests for `resources/models/v1/embeddings.ts` (#631).
 *
 * REST.ts hands the handler `request.data`, which is an unawaited Promise for
 * JSON bodies — the handler must `await` it before reading any field.
 */

const assert = require('node:assert');
require('#src/resources/databases');
const { setEmbedding, clearRegistry } = require('#src/resources/models/backendRegistry');
const { TestBackend } = require('#src/resources/models/TestBackend');
const { V1Embeddings } = require('#src/resources/models/v1/embeddings');

describe('V1Embeddings.post', () => {
	beforeEach(() => {
		setEmbedding('default', new TestBackend());
	});

	afterEach(() => {
		clearRegistry();
	});

	it('returns embeddings for a plain-object body (unit-test caller shape)', async () => {
		const body = { input: 'hello world' };
		const result = await V1Embeddings.post(undefined, body, {});
		assert.equal(result.object, 'list');
		assert.equal(result.data.length, 1);
	});

	it('awaits a Promise-wrapped body, matching REST.ts passing request.data unawaited', async () => {
		const body = Promise.resolve({ input: ['a', 'b'] });
		const result = await V1Embeddings.post(undefined, body, {});
		assert.equal(result.object, 'list');
		assert.equal(result.data.length, 2);
	});
});
