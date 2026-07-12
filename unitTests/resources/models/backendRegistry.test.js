'use strict';

const assert = require('node:assert');
const {
	setEmbedding,
	setGenerative,
	resolveEmbedding,
	resolveGenerative,
	clearRegistry,
	registerBackend,
	defineBackend,
	ModelBackendNotFoundError,
	ModelBackendRegistrationError,
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

describe('registerBackend', () => {
	const embedSpec = { embed: async () => ({ status: 'completed', output: [] }) };
	const generateSpec = {
		generate: async () => ({ status: 'completed', output: { content: '', finishReason: 'stop' } }),
	};

	beforeEach(() => clearRegistry());

	it('registers and resolves an embedding backend by id', () => {
		const backend = defineBackend({ name: 'local:e', ...embedSpec });
		registerBackend('embedding', 'local:e', backend);
		assert.strictEqual(resolveEmbedding('local:e'), backend);
	});

	it('registers and resolves a generative backend by id', () => {
		const backend = defineBackend({ name: 'local:g', ...generateSpec });
		registerBackend('generative', 'local:g', backend);
		assert.strictEqual(resolveGenerative('local:g'), backend);
	});

	it('accepts a stream-only generative backend', () => {
		const backend = defineBackend({ name: 'local:s', generateStream: async function* () {} });
		registerBackend('generative', 'local:s', backend);
		assert.strictEqual(resolveGenerative('local:s'), backend);
	});

	it('re-registering the same id replaces the prior backend', () => {
		const a = defineBackend({ name: 'a', ...embedSpec });
		const b = defineBackend({ name: 'b', ...embedSpec });
		registerBackend('embedding', 'x', a);
		registerBackend('embedding', 'x', b);
		assert.strictEqual(resolveEmbedding('x'), b);
	});

	it('throws on an invalid kind', () => {
		assert.throws(() => registerBackend('bogus', 'x', fakeBackend('k')), ModelBackendRegistrationError);
	});

	it('throws on an empty id', () => {
		assert.throws(
			() => registerBackend('embedding', '', defineBackend({ name: 'k', ...embedSpec })),
			ModelBackendRegistrationError
		);
	});

	it('throws when an embedding backend has no embed()', () => {
		assert.throws(
			() => registerBackend('embedding', 'x', defineBackend({ name: 'g-only', ...generateSpec })),
			ModelBackendRegistrationError
		);
	});

	it('throws when a generative backend has neither generate() nor generateStream()', () => {
		assert.throws(
			() => registerBackend('generative', 'x', defineBackend({ name: 'e-only', ...embedSpec })),
			ModelBackendRegistrationError
		);
	});

	it('throws when the backend lacks a name or capabilities()', () => {
		assert.throws(() => registerBackend('embedding', 'x', { embed: async () => ({}) }), ModelBackendRegistrationError);
	});
});
