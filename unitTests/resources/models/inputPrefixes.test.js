'use strict';

const assert = require('node:assert');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { setupTestDBPath } = require('../../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { Models } = require('#src/resources/models/Models');
const { bootstrapModels, applyModelsConfig, resetModelsProjection } = require('#src/resources/models/bootstrap');
const { clearRegistry } = require('#src/resources/models/backendRegistry');
const { clearRouting } = require('#src/resources/models/routing');
const { __setEmbedFnForTest } = require('#src/resources/models/embedHook');

const PREFIXES = { document: 'search_document: ', query: 'search_query: ' };

describe('OpenAI entry inputPrefixes through bootstrap, hooks and HTTP', () => {
	let server;
	let baseUrl;
	let calls;
	let models;

	before(async () => {
		setupTestDBPath();
		server = createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString());
			calls.push({ path: req.url, body });
			if (body.model === 'unavailable') {
				res.writeHead(503).end();
			} else {
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }));
			}
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
		__setEmbedFnForTest(undefined);
		models = new Models({ write() {} }, () => {});
	});

	afterEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
		__setEmbedFnForTest(undefined);
	});

	after(async () => {
		if (server?.listening)
			await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});

	function entry(extra = {}) {
		return { backend: 'openai', apiKey: 'test', baseUrl, model: 'served-alias', requestTimeoutMs: 2000, ...extra };
	}

	it('sends the document prefix from the default @embed write hook and query prefix from Models', async () => {
		await bootstrapModels({ models: { embedding: { default: entry({ inputPrefixes: PREFIXES }) } } });
		const T = table({
			database: 'test',
			table: 'PrefixedEmbedDoc',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'content', type: 'String' },
				{ name: 'embedding', type: 'Array', embed: { source: 'content', model: 'default' } },
			],
		});
		T.updatedAttributes();
		await transaction((context) => T.put({ id: 'doc', content: 'hello' }, context));
		assert.deepStrictEqual(Array.from((await T.get('doc')).embedding), [1, 2, 3]);
		await models.embed('question', { inputType: 'query' });
		assert.deepStrictEqual(
			calls.map((call) => call.body.input),
			[['search_document: hello'], ['search_query: question']]
		);
		assert.ok(calls.every((call) => call.path === '/v1/embeddings'));
	});

	it('applies valid reloads and prefix removal, retaining the old entry on invalid reload', async () => {
		const config = { embedding: { default: entry({ inputPrefixes: PREFIXES }) } };
		await bootstrapModels({ models: config });
		await models.embed('q', { inputType: 'query' });
		config.embedding.default.inputPrefixes = { query: 'updated: ' };
		await applyModelsConfig(config);
		await models.embed('q', { inputType: 'query' });
		await applyModelsConfig({ embedding: { default: entry({ inputPrefixes: { query: 42 } }) } });
		await models.embed('q', { inputType: 'query' });
		await applyModelsConfig({ embedding: { default: entry() } });
		await models.embed('q', { inputType: 'query' });
		assert.deepStrictEqual(
			calls.map((call) => call.body.input),
			[['search_query: q'], ['updated: q'], ['updated: q'], ['q']]
		);
	});

	it('lets the fallback format the original text with its own configuration', async () => {
		await bootstrapModels({
			models: {
				embedding: {
					default: entry({ model: 'unavailable', inputPrefixes: PREFIXES, fallback: ['plain'] }),
					plain: entry(),
				},
			},
		});
		await models.embed('q', { inputType: 'query' });
		assert.deepStrictEqual(
			calls.map((call) => call.body.input),
			[['search_query: q'], ['q']]
		);
	});
});
