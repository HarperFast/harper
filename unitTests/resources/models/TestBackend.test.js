'use strict';

const assert = require('node:assert/strict');
const { TestBackend } = require('#src/resources/models/TestBackend');

describe('TestBackend', () => {
	let backend;
	beforeEach(() => {
		backend = new TestBackend();
	});

	describe('capabilities', () => {
		it('returns the Phase 1 capability shape', () => {
			assert.deepStrictEqual(backend.capabilities(), {
				embed: true,
				generate: true,
				stream: true,
				tools: false,
				adapters: false,
			});
		});

		it('reports name = "test"', () => {
			assert.strictEqual(backend.name, 'test');
		});
	});

	describe('embed', () => {
		const accounting = { tenantId: 'tid', app: '/test' };

		it('returns a Float32Array per input string', async () => {
			const result = await backend.embed(['a', 'b'], { accounting });
			assert.strictEqual(result.status, 'completed');
			assert.strictEqual(result.output.length, 2);
			assert.ok(result.output[0] instanceof Float32Array);
			assert.strictEqual(result.output[0].length, 16);
		});

		it('accepts a single string and returns one vector', async () => {
			const result = await backend.embed('hello', { accounting });
			assert.strictEqual(result.output.length, 1);
			assert.strictEqual(result.output[0].length, 16);
		});

		it('is deterministic — same input yields the same vector across calls', async () => {
			const a = await backend.embed('hello', { accounting });
			const b = await backend.embed('hello', { accounting });
			assert.deepStrictEqual(Array.from(a.output[0]), Array.from(b.output[0]));
		});

		it('produces different vectors for different inputs', async () => {
			const a = await backend.embed('hello', { accounting });
			const b = await backend.embed('world', { accounting });
			assert.notDeepStrictEqual(Array.from(a.output[0]), Array.from(b.output[0]));
		});

		it('reports embeddingTokens equal to total input length', async () => {
			const result = await backend.embed(['ab', 'cde'], { accounting });
			assert.strictEqual(result.usage.embeddingTokens, 5);
		});
	});

	describe('generate', () => {
		const accounting = { tenantId: 'tid', app: '/test' };

		it('echoes a string input with the TestBackend prefix', async () => {
			const result = await backend.generate('hi', { accounting });
			assert.strictEqual(result.status, 'completed');
			assert.strictEqual(result.output.content, '[TestBackend echoed]: hi');
			assert.strictEqual(result.output.finishReason, 'stop');
		});

		it('joins messages into content when given a Message[] input', async () => {
			const result = await backend.generate(
				[
					{ role: 'user', content: 'one' },
					{ role: 'assistant', content: 'two' },
				],
				{ accounting }
			);
			assert.ok(result.output.content.includes('one two'));
		});

		it('joins messages into content when given a { messages, system, tools } object input', async () => {
			const result = await backend.generate(
				{
					system: 'sys',
					messages: [
						{ role: 'user', content: 'alpha' },
						{ role: 'assistant', content: 'beta' },
					],
				},
				{ accounting }
			);
			assert.ok(result.output.content.includes('alpha beta'));
		});

		it('reports promptTokens and completionTokens in usage', async () => {
			const result = await backend.generate('hi', { accounting });
			assert.strictEqual(result.usage.promptTokens, 2);
			assert.ok(result.usage.completionTokens > 0);
		});
	});

	describe('generateStream', () => {
		const accounting = { tenantId: 'tid', app: '/test' };

		it('yields chunks then a finishReason chunk', async () => {
			const chunks = [];
			for await (const chunk of backend.generateStream('hello', { accounting })) {
				chunks.push(chunk);
			}
			const lastChunk = chunks[chunks.length - 1];
			assert.strictEqual(lastChunk.finishReason, 'stop');
			const concatenated = chunks
				.map((c) => c.deltaContent ?? '')
				.join('')
				.trim();
			assert.ok(concatenated.startsWith('[TestBackend stream]:'));
		});
	});
});
