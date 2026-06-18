'use strict';

const assert = require('node:assert/strict');
// Prime Harper's module graph in the same order the other models unit tests do
// (see Models.test.js) so the transaction.ts ↔ blob require chain resolves.
require('#src/resources/databases');
const {
	registerBackend,
	defineBackend,
	clearRegistry,
	ModelBackendRegistrationError,
} = require('#src/resources/models/backendRegistry');
const { Models } = require('#src/resources/models/Models');

function makeMockWriter() {
	const records = [];
	return { records, write: (record) => records.push(record) };
}

const embedFn = async (input) => {
	const texts = Array.isArray(input) ? input : [input];
	return { status: 'completed', output: texts.map(() => Float32Array.from([0.1, 0.2, 0.3])) };
};

describe('defineBackend', () => {
	it('derives capabilities from the methods supplied (embed-only)', () => {
		const b = defineBackend({ name: 'local:e', embed: embedFn });
		assert.deepStrictEqual(b.capabilities(), {
			embed: true,
			generate: false,
			stream: false,
			tools: false,
			adapters: false,
		});
		assert.strictEqual(typeof b.embed, 'function');
		assert.strictEqual(b.generate, undefined);
		assert.strictEqual(b.generateStream, undefined);
	});

	it('derives generate + stream capabilities', () => {
		const b = defineBackend({
			name: 'local:g',
			generate: async () => ({ status: 'completed', output: { content: '', finishReason: 'stop' } }),
			generateStream: async function* () {},
		});
		assert.deepStrictEqual(b.capabilities(), {
			embed: false,
			generate: true,
			stream: true,
			tools: false,
			adapters: false,
		});
	});

	it('honors explicit tools / adapters flags (not inferable from methods)', () => {
		const b = defineBackend({
			name: 'local:t',
			generate: async () => ({ status: 'completed', output: { content: '', finishReason: 'stop' } }),
			tools: true,
			adapters: true,
		});
		assert.strictEqual(b.capabilities().tools, true);
		assert.strictEqual(b.capabilities().adapters, true);
	});

	it('returns a frozen, stable capabilities object', () => {
		const b = defineBackend({ name: 'local:f', embed: embedFn });
		assert.ok(Object.isFrozen(b.capabilities()));
		assert.strictEqual(b.capabilities(), b.capabilities());
	});

	it('throws without a name', () => {
		assert.throws(() => defineBackend({ embed: embedFn }), ModelBackendRegistrationError);
	});

	it('throws when no method is supplied', () => {
		assert.throws(() => defineBackend({ name: 'empty' }), ModelBackendRegistrationError);
	});
});

describe('registerBackend + defineBackend end-to-end through Models', () => {
	beforeEach(() => clearRegistry());
	afterEach(() => clearRegistry());

	it('a registered in-process embedding backend resolves through models.embed({ model })', async () => {
		registerBackend('embedding', 'local:test-embed', defineBackend({ name: 'local:test-embed', embed: embedFn }));
		const models = new Models(makeMockWriter(), () => {});
		const vectors = await models.embed('hello', { model: 'local:test-embed' });
		assert.ok(Array.isArray(vectors));
		assert.ok(vectors[0] instanceof Float32Array);
		assert.strictEqual(vectors[0].length, 3);
	});

	it('models.registerBackend (the scope.models path) registers too', async () => {
		const models = new Models(makeMockWriter(), () => {});
		models.registerBackend(
			'embedding',
			'local:via-method',
			defineBackend({ name: 'local:via-method', embed: embedFn })
		);
		const vectors = await models.embed('hi', { model: 'local:via-method' });
		assert.ok(vectors[0] instanceof Float32Array);
	});
});
