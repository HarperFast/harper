'use strict';

const assert = require('node:assert/strict');
const {
	setEmbedding,
	setGenerative,
	resolveEmbedding,
	resolveGenerative,
	clearRegistry,
	ModelBackendNotFoundError,
} = require('#src/resources/models/backendRegistry');

function fakeBackend(name) {
	return {
		name,
		capabilities: () => ({ embed: true, generate: true, stream: true, tools: false, adapters: false }),
	};
}

describe('backendRegistry', () => {
	beforeEach(() => {
		clearRegistry();
	});

	it('resolves an embedding backend by logical name', () => {
		const backend = fakeBackend('test');
		setEmbedding('default', backend);
		assert.strictEqual(resolveEmbedding('default'), backend);
	});

	it("defaults logicalName to 'default' when omitted", () => {
		const backend = fakeBackend('test');
		setEmbedding('default', backend);
		assert.strictEqual(resolveEmbedding(), backend);
	});

	it('resolves multiple logical names to different backends', () => {
		const a = fakeBackend('a');
		const b = fakeBackend('b');
		setEmbedding('default', a);
		setEmbedding('fast', b);
		assert.strictEqual(resolveEmbedding('default'), a);
		assert.strictEqual(resolveEmbedding('fast'), b);
	});

	it('resolves generative independently from embedding', () => {
		const e = fakeBackend('emb');
		const g = fakeBackend('gen');
		setEmbedding('default', e);
		setGenerative('default', g);
		assert.strictEqual(resolveEmbedding('default'), e);
		assert.strictEqual(resolveGenerative('default'), g);
	});

	it('throws ModelBackendNotFoundError when no backend is registered for the name', () => {
		assert.throws(
			() => resolveEmbedding('missing'),
			(err) => err instanceof ModelBackendNotFoundError && err.statusCode === 500
		);
	});

	it('re-mapping the same logical name replaces the prior backend', () => {
		const first = fakeBackend('first');
		const second = fakeBackend('second');
		setEmbedding('default', first);
		setEmbedding('default', second);
		assert.strictEqual(resolveEmbedding('default'), second);
	});

	it('clearRegistry() removes all mappings', () => {
		setEmbedding('default', fakeBackend('test'));
		setGenerative('default', fakeBackend('test'));
		clearRegistry();
		assert.throws(() => resolveEmbedding('default'), ModelBackendNotFoundError);
		assert.throws(() => resolveGenerative('default'), ModelBackendNotFoundError);
	});

	it('error message identifies kind + logical name but never enumerates other registrations', () => {
		setEmbedding('default', fakeBackend('secret-backend-name'));
		try {
			resolveEmbedding('other');
			assert.fail('expected error');
		} catch (err) {
			assert.ok(!err.message.includes('secret-backend-name'), 'error should not enumerate registered backend names');
			assert.ok(err.message.includes('embedding.other'));
		}
	});
});
