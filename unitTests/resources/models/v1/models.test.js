'use strict';

/**
 * Unit tests for `resources/models/v1/models.ts` (#631).
 *
 * Covers the adjudicated auth blocker: anonymous / non-super_user requests must
 * be rejected with an OpenAI-shape 401 / 403 envelope, mirroring Resource's
 * default `allowRead` gate that the static `get()` override bypasses.
 */

const assert = require('node:assert');
require('#src/resources/databases');
const { setGenerative, setEmbedding, clearRegistry } = require('#src/resources/models/backendRegistry');
const { TestBackend } = require('#src/resources/models/TestBackend');
const { V1Models } = require('#src/resources/models/v1/models');

const SUPER_USER = { role: { permission: { super_user: true } } };
const NON_SUPER_USER = { role: { permission: { super_user: false } } };

describe('V1Models.get', () => {
	afterEach(() => {
		clearRegistry();
	});

	it('lists registered generative and embedding backends for a super_user', () => {
		setGenerative('default', new TestBackend());
		setEmbedding('embed-small', new TestBackend());
		const result = V1Models.get(undefined, { user: SUPER_USER });
		assert.equal(result.object, 'list');
		assert.deepEqual(
			result.data.map((m) => m.id),
			['default', 'embed-small']
		);
		assert.ok(result.data.every((m) => m.object === 'model'));
	});

	it('dedupes a logical name registered for both generative and embedding', () => {
		setGenerative('default', new TestBackend());
		setEmbedding('default', new TestBackend());
		const result = V1Models.get(undefined, { user: SUPER_USER });
		assert.deepEqual(
			result.data.map((m) => m.id),
			['default']
		);
	});

	it('rejects an anonymous request with a 401 OpenAI-shape envelope', () => {
		const result = V1Models.get(undefined, {});
		assert.equal(result.status, 401);
		assert.equal(result.data.error.type, 'authentication_error');
	});

	it('rejects a non-super_user request with a 403 OpenAI-shape envelope', () => {
		const result = V1Models.get(undefined, { user: NON_SUPER_USER });
		assert.equal(result.status, 403);
		assert.equal(result.data.error.type, 'permission_error');
	});
});
