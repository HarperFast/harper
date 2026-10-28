'use strict';

const assert = require('node:assert');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { setupTestDBPath } = require('../../testUtils');
// Same module-graph priming as Models.test.js.
require('#src/resources/databases');
const { bootstrapModels, applyModelsConfig, resetModelsProjection } = require('#src/resources/models/bootstrap');
const { setEmbedding, clearRegistry, defineBackend } = require('#src/resources/models/backendRegistry');
const { registerRouter, clearRouting, setFallbackGroup } = require('#src/resources/models/routing');
const { TestBackend } = require('#src/resources/models/TestBackend');
const { isContextWindowExceeded } = require('#src/resources/models/backendHelpers');
const { Models, ModelCapabilityError } = require('#src/resources/models/Models');

function spyBackend(name, { truncate = false } = {}) {
	const calls = [];
	const backend = defineBackend({
		name,
		truncate,
		embed: async (input, opts) => {
			calls.push({ input, truncate: opts.truncate });
			const texts = Array.isArray(input) ? input : [input];
			return { status: 'completed', output: texts.map(() => Float32Array.of(texts.length)) };
		},
	});
	return { backend, calls };
}

describe('models.embed truncate option', () => {
	let records;
	let models;

	beforeEach(() => {
		clearRegistry();
		clearRouting();
		records = [];
		models = new Models({ write: (record) => records.push(record) }, () => {});
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
	});

	it('cuts each over-long input to the window keeping its start, and leaves the caller input alone', async () => {
		const window = 8;
		setEmbedding('default', new TestBackend({ contextWindow: window }));
		const input = Object.freeze(['short', 'beginning-of-a-long-text']);
		const vectors = await models.embed(input, { truncate: true });
		const reference = await models.embed(['short', 'beginning-of-a-long-text'.slice(0, window)]);
		assert.deepStrictEqual(vectors, reference);
		assert.deepStrictEqual(input, ['short', 'beginning-of-a-long-text']);
	});

	it('fails an over-long input as a context-window error when truncate is absent or false', async () => {
		setEmbedding('default', new TestBackend({ contextWindow: 4 }));
		for (const opts of [{}, { truncate: false }]) {
			await assert.rejects(models.embed('too long', opts), (err) => isContextWindowExceeded(err), JSON.stringify(opts));
		}
	});

	it('requires the truncate capability only for truncate: true', async () => {
		const { backend, calls } = spyBackend('plain');
		setEmbedding('default', backend);
		await models.embed('x');
		await models.embed('x', { truncate: false });
		assert.deepStrictEqual(
			calls.map((call) => call.truncate),
			[undefined, false]
		);
		await assert.rejects(
			models.embed('x', { truncate: true }),
			(err) => err instanceof ModelCapabilityError && /'truncate'/.test(err.message)
		);
		assert.strictEqual(calls.length, 2, 'an incapable backend is never invoked with truncate: true');
		assert.deepStrictEqual(
			records.map((r) => [r.backend, r.success, r.error_code]),
			[
				['plain', true, undefined],
				['plain', true, undefined],
				['plain', false, 'capability_unsupported'],
			]
		);
	});

	it('routes truncate: true past an incapable primary to a fallback that can truncate', async () => {
		const primary = spyBackend('plain');
		const fallback = spyBackend('truncating', { truncate: true });
		setEmbedding('default', primary.backend);
		setEmbedding('backup', fallback.backend);
		setFallbackGroup('embedding', 'default', ['backup']);
		await models.embed('x', { truncate: true });
		assert.strictEqual(primary.calls.length, 0);
		assert.deepStrictEqual(fallback.calls, [{ input: 'x', truncate: true }]);
		await models.embed('y');
		assert.strictEqual(primary.calls.length, 1, 'without the option the primary serves as before');
	});

	it('refuses a candidate a custom router returns without truncate, then serves from the next one', async () => {
		const plain = spyBackend('plain');
		const truncating = spyBackend('truncating', { truncate: true });
		registerRouter({ route: () => [plain.backend, truncating.backend] });
		await models.embed('x', { truncate: true });
		assert.strictEqual(plain.calls.length, 0);
		assert.strictEqual(truncating.calls.length, 1);
		assert.deepStrictEqual(
			records.map((r) => [r.backend, r.success, r.error_code]),
			[
				['plain', false, 'capability_unsupported'],
				['truncating', true, undefined],
			]
		);
	});

	it("adds the requirement once and never to the caller's requires array", async () => {
		const routed = [];
		const { backend } = spyBackend('truncating', { truncate: true });
		registerRouter({
			route: (req) => {
				routed.push(req.requires);
				return [backend];
			},
		});
		const requires = Object.freeze(['truncate']);
		await models.embed('x', { truncate: true, requires });
		await models.embed('x', { truncate: true });
		assert.deepStrictEqual(routed, [
			['embed', 'truncate'],
			['embed', 'truncate'],
		]);
		assert.deepStrictEqual(requires, ['truncate']);
	});
});

describe("OpenAI entry truncation: 'vllm' through bootstrap and HTTP", () => {
	const WINDOW = 16;
	let server;
	let baseUrl;
	let calls;
	let models;

	before(async () => {
		setupTestDBPath();
		// Stands in for vLLM: rejects an input over the window unless asked to keep its first WINDOW characters.
		server = createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString());
			calls.push(body);
			const keepsStart = body.truncate_prompt_tokens === -1 && body.truncation_side === 'right';
			res.setHeader('Content-Type', 'application/json');
			if (!keepsStart && body.input.some((text) => text.length > WINDOW)) {
				res
					.writeHead(400)
					.end(JSON.stringify({ error: { message: "This model's maximum context length is 16 tokens" } }));
				return;
			}
			const kept = body.input.map((text) => text.slice(0, WINDOW));
			res.end(JSON.stringify({ data: kept.map((text, index) => ({ index, embedding: [text.length] })) }));
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	});

	beforeEach(() => {
		calls = [];
		clearRegistry();
		clearRouting();
		resetModelsProjection();
		models = new Models({ write() {} }, () => {});
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
	});

	after(async () => {
		if (server?.listening)
			await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});

	function entry(extra = {}) {
		return { backend: 'openai', apiKey: 'test', baseUrl, model: 'nomic', requestTimeoutMs: 2000, ...extra };
	}

	const LONG = 'search me first, then the rest of a long memory';

	it('embeds an over-window input with truncate: true and fails it without', async () => {
		await bootstrapModels({
			models: { embedding: { default: entry({ truncation: 'vllm', inputPrefixes: { document: 'doc: ' } }) } },
		});
		const [vector] = await models.embed(LONG, { truncate: true, inputType: 'document' });
		assert.deepStrictEqual(Array.from(vector), [WINDOW]);
		await assert.rejects(models.embed(LONG, { inputType: 'document' }), (err) => err.contextWindowExceeded === true);
		assert.deepStrictEqual(calls, [
			{ model: 'nomic', input: ['doc: ' + LONG], truncate_prompt_tokens: -1, truncation_side: 'right' },
			{ model: 'nomic', input: ['doc: ' + LONG] },
		]);
	});

	it('follows reloads: removing truncation withdraws the capability, an invalid value keeps the previous entry', async () => {
		const config = { embedding: { default: entry({ truncation: 'vllm' }) } };
		await bootstrapModels({ models: config });
		await models.embed(LONG, { truncate: true });
		await applyModelsConfig({ embedding: { default: entry({ truncation: 'tei' }) } });
		await models.embed(LONG, { truncate: true });
		await applyModelsConfig({ embedding: { default: entry() } });
		await assert.rejects(models.embed(LONG, { truncate: true }), ModelCapabilityError);
		assert.strictEqual(calls.length, 2, 'an entry without truncation is refused before any request');
		assert.ok(calls.every((call) => call.truncate_prompt_tokens === -1));
	});
});
