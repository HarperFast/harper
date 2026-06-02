/**
 * `@embed` directive integration test.
 *
 * Spins up a fake Ollama HTTP server inside the test, points Harper's models
 * config at it, deploys a schema with `@embed`, and exercises these paths
 * end-to-end:
 *
 *   1. **Happy path** — POST a record → fake-ollama returns a deterministic
 *      vector → record stores the vector at the `@embed`-decorated field.
 *
 *   2. **Source-unchanged PATCH** — PATCH a record with a non-source field →
 *      no new embed call is made (fake-ollama hit count stays flat); the
 *      existing embedding survives via patch-merge.
 *
 *   3. **Source-changing PATCH** — PATCH a record with the source field →
 *      embed fires once, the stored vector matches the NEW content.
 *
 *   4. **PUT (full-record update)** — embed fires once, stored vector reflects new content.
 *
 *   5. **Replication-receiver skip** — POST with `x-replicate-from: none` and a
 *      pre-supplied vector → no embed call; the supplied vector is stored as-is.
 *
 *   6. **Caching-table `@embed`** — GET fires `getFromSource`; the cache write
 *      (which bypasses `_writeUpdate`) ends up with a populated vector.
 *
 * The fake-ollama server returns deterministic 3-element vectors derived from the
 * input text so assertions can compare exact values.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
// .mjs siblings — TypeScript needs `// @ts-expect-error` because no declaration files exist
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';
import request from 'supertest';

const SCHEMA_GRAPHQL = [
	'type EmbedDoc @table(database: "embedtest") @sealed @export {',
	'\tid: ID! @primaryKey',
	'\tcontent: String',
	'\ttag: String',
	'\tembedding: [Float] @embed(source: "content", model: "default")',
	'}',
	'',
	'type CachedEmbedDoc @table(database: "embedtest") @sealed @export {',
	'\tid: ID! @primaryKey',
	'\tcontent: String',
	'\tembedding: [Float] @embed(source: "content", model: "default")',
	'}',
	'',
].join('\n');

// resources.js wiring for the caching-table @embed path. The Resource base class
// and the `databases` global are provided by Harper's component loader at boot.
const RESOURCES_JS = [
	'const { CachedEmbedDoc } = databases.embedtest;',
	'',
	'export class CachedEmbedSource extends Resource {',
	'\tasync get() {',
	'\t\tconst id = this.getId();',
	'\t\treturn { id, content: `derived content for ${id}` };',
	'\t}',
	'}',
	'',
	'CachedEmbedDoc.sourcedFrom(CachedEmbedSource);',
	'',
].join('\n');

/** Vectors are stored and returned as a plain JSON number[]. */
function decodeVector(field: any): number[] | undefined {
	return Array.isArray(field) ? field.map(Number) : undefined;
}

interface FakeOllama {
	url: string;
	host: string; // <host:port> form for Harper's `host:` config field
	close: () => Promise<void>;
	embedCallCount: () => number;
	lastEmbedInputs: () => string[][];
	reset: () => void;
}

/**
 * Deterministic fake embedder: maps an input string to a stable 3-element
 * vector so assertions can compare exact values.
 */
function deterministicVector(input: string): number[] {
	let h1 = 0;
	let h2 = 0;
	let h3 = 0;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		h1 = (h1 * 31 + c) % 9973;
		h2 = (h2 * 37 + c) % 9967;
		h3 = (h3 * 41 + c) % 9941;
	}
	// Normalize to (0, 1) range
	return [h1 / 9973, h2 / 9967, h3 / 9941];
}

async function startFakeOllama(): Promise<FakeOllama> {
	let embedCalls = 0;
	const embedInputs: string[][] = [];
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method === 'POST' && req.url === '/api/embed') {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				try {
					const parsed = JSON.parse(body) as { model: string; input: string | string[] };
					const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
					embedCalls++;
					embedInputs.push(inputs);
					const embeddings = inputs.map((s) => deterministicVector(s));
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ embeddings, prompt_eval_count: inputs.join(' ').length }));
				} catch (err) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: String(err) }));
				}
			});
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const addr = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${addr.port}`;
	const host = `127.0.0.1:${addr.port}`;
	return {
		url,
		host,
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
		embedCallCount: () => embedCalls,
		lastEmbedInputs: () => embedInputs,
		reset: () => {
			embedCalls = 0;
			embedInputs.length = 0;
		},
	};
}

suite('@embed directive end-to-end with fake Ollama', (ctx: any) => {
	let fake: FakeOllama;
	let client: any;

	before(async () => {
		fake = await startFakeOllama();
		// Local debugging: setting HARPER_INTEGRATION_TEST_FORCE_LOOPBACK forces the
		// 127.0.0.1 fast-path so the test runs without `harper-integration-test-setup-loopback`
		// (macOS dev machines don't have the pool by default). CI uses the pool normally.
		if (process.env.HARPER_INTEGRATION_TEST_FORCE_LOOPBACK) {
			ctx.harper = { ...ctx.harper, hostname: '127.0.0.1' };
		}
		await startHarper(ctx, {
			config: {
				logging: { auditLog: true },
				models: {
					embedding: {
						default: { backend: 'ollama', host: fake.host, model: 'fake-embed' },
					},
				},
			},
			env: {},
		});
		client = createApiClient(ctx.harper);

		await client
			.req()
			.send({ operation: 'add_component', project: 'embedtest' })
			.expect((r: any) => {
				const text = JSON.stringify(r.body);
				ok(text.includes('Successfully added project') || text.includes('Project already exists'), r.text);
			});

		await client
			.req()
			.send({ operation: 'set_component_file', project: 'embedtest', file: 'schema.graphql', payload: SCHEMA_GRAPHQL })
			.expect((r: any) => ok(r.body?.message?.includes?.('Successfully set component: schema.graphql'), r.text))
			.expect(200);

		await client
			.req()
			.send({ operation: 'set_component_file', project: 'embedtest', file: 'resources.js', payload: RESOURCES_JS })
			.expect((r: any) => ok(r.body?.message?.includes?.('Successfully set component: resources.js'), r.text))
			.expect(200);

		await restartHttpWorkers(client, '/openapi');
		fake.reset();
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			await fake.close();
		}
	});

	test('schema with @embed creates EmbedDoc table', async () => {
		const desc = await client.req().send({ operation: 'describe_all' }).expect(200);
		const embedDoc = desc.body?.embedtest?.EmbedDoc;
		ok(embedDoc, 'EmbedDoc table not created');
		const embeddingAttr = (embedDoc.attributes || []).find((a: any) => a.attribute === 'embedding');
		ok(embeddingAttr, 'embedding attribute should be present');
		strictEqual(embeddingAttr.type, 'array', 'embedding type should be a [Float] array');
		strictEqual(embeddingAttr.indexed?.type, 'HNSW', 'embedding should be auto-HNSW-indexed');
		// describe should surface the @embed config, not just the auto-added HNSW index
		ok(embeddingAttr.embed, 'describe should surface @embed config');
		strictEqual(embeddingAttr.embed.source, 'content');
		strictEqual(embeddingAttr.embed.model, 'default');
	});

	test('happy path: POST → embedder runs → vector stored on record', async () => {
		fake.reset();
		const content = 'harper is a database';
		const expected = deterministicVector(content);

		await request(ctx.harper.httpURL)
			.post('/EmbedDoc/')
			.set(client.headers)
			.send({ id: 'doc-happy', content })
			.expect((r: any) => ok([200, 201, 204].includes(r.status), `unexpected status ${r.status}: ${r.text}`));

		// Verify the fake-ollama received exactly one embed call with the source text
		strictEqual(fake.embedCallCount(), 1, 'expected exactly one embed call');
		const inputs = fake.lastEmbedInputs()[0];
		strictEqual(inputs.length, 1);
		ok(inputs[0].includes(content), `embed input "${inputs[0]}" should contain source text`);

		// GET the record back and verify the embedding was stored
		const getResp = await client.reqRest('/EmbedDoc/doc-happy').expect(200);
		const body = getResp.body as { id: string; content: string; embedding: unknown };
		strictEqual(body.id, 'doc-happy');
		strictEqual(body.content, content);
		const stored = decodeVector(body.embedding);
		ok(stored, `embedding field should be populated, got: ${JSON.stringify(body.embedding)}`);
		strictEqual(stored.length, 3, 'expected 3-element vector');
		for (let i = 0; i < 3; i++) {
			ok(
				Math.abs(stored[i] - expected[i]) < 1e-5,
				`vector[${i}] mismatch: stored=${stored[i]} expected=${expected[i]}`
			);
		}
	});

	test('PATCH unrelated field does NOT re-run embedder; existing embedding survives', async () => {
		// Seed a record first
		const content = 'patch baseline content';
		await request(ctx.harper.httpURL)
			.post('/EmbedDoc/')
			.set(client.headers)
			.send({ id: 'doc-patch', content })
			.expect((r: any) => ok([200, 201, 204].includes(r.status), `seed POST status ${r.status}: ${r.text}`));

		const baselineEmbedCalls = fake.embedCallCount();

		// PATCH a non-source field. The embed hook's source-presence predicate should skip;
		// no new embed call should fire and the existing vector should remain unchanged.
		await request(ctx.harper.httpURL)
			.patch('/EmbedDoc/doc-patch')
			.set(client.headers)
			.send({ tag: 'updated' })
			.expect((r: any) => ok([200, 204].includes(r.status), `PATCH status ${r.status}: ${r.text}`));

		strictEqual(
			fake.embedCallCount(),
			baselineEmbedCalls,
			'embed should not fire when the source field is not in the PATCH payload'
		);

		// Verify the embedding is still the one from the original content
		const expected = deterministicVector(content);
		const getResp = await client.reqRest('/EmbedDoc/doc-patch').expect(200);
		const body = getResp.body as { tag: string; embedding: unknown };
		strictEqual(body.tag, 'updated');
		const stored = decodeVector(body.embedding);
		ok(stored, `embedding should still be populated after non-source PATCH, got: ${JSON.stringify(body.embedding)}`);
		strictEqual(stored.length, 3);
		for (let i = 0; i < 3; i++) {
			ok(Math.abs(stored[i] - expected[i]) < 1e-5, 'existing embedding should survive non-source PATCH');
		}
	});

	test('PATCH source field DOES re-run embedder; stored vector matches new content', async () => {
		// Seed a record with one content value.
		const initialContent = 'patch-source baseline';
		await request(ctx.harper.httpURL)
			.post('/EmbedDoc/')
			.set(client.headers)
			.send({ id: 'doc-source-patch', content: initialContent })
			.expect((r: any) => ok([200, 201, 204].includes(r.status), `seed POST status ${r.status}: ${r.text}`));

		const baselineEmbedCalls = fake.embedCallCount();

		// PATCH the source field — exercises the async `update()` path where the embed
		// promise must be awaited before commit.
		const updatedContent = 'patch-source updated text';
		await request(ctx.harper.httpURL)
			.patch('/EmbedDoc/doc-source-patch')
			.set(client.headers)
			.send({ content: updatedContent })
			.expect((r: any) => ok([200, 204].includes(r.status), `PATCH status ${r.status}: ${r.text}`));

		strictEqual(
			fake.embedCallCount(),
			baselineEmbedCalls + 1,
			'embed should fire exactly once when the source field is in the PATCH payload'
		);
		const inputs = fake.lastEmbedInputs().at(-1)!;
		ok(
			inputs.some((s) => s.includes(updatedContent)),
			`embed input ${JSON.stringify(inputs)} should reflect the updated content`
		);

		// Verify the stored vector matches the NEW content, not the seed.
		const expected = deterministicVector(updatedContent);
		const getResp = await client.reqRest('/EmbedDoc/doc-source-patch').expect(200);
		const body = getResp.body as { id: string; content: string; embedding: unknown };
		strictEqual(body.content, updatedContent, 'PATCH should have updated the source field');
		const stored = decodeVector(body.embedding);
		ok(stored, `embedding should be populated after source PATCH, got: ${JSON.stringify(body.embedding)}`);
		strictEqual(stored.length, 3);
		for (let i = 0; i < 3; i++) {
			ok(
				Math.abs(stored[i] - expected[i]) < 1e-5,
				`vector[${i}] mismatch: stored=${stored[i]} expected (from new content)=${expected[i]}`
			);
		}
	});

	test('PUT (full-record update) on existing row re-runs embedder', async () => {
		// PUT exercises the SAME legacy-URLSearchParams branch in Table.ts that PATCH does
		// (REST dispatches as `resource.put(data, query)`; the query is a URLSearchParams,
		// so put() takes the back-compat branch that — pre-fix — dropped update()'s promise).
		await request(ctx.harper.httpURL)
			.post('/EmbedDoc/')
			.set(client.headers)
			.send({ id: 'doc-put-source', content: 'put baseline' })
			.expect((r: any) => ok([200, 201, 204].includes(r.status), `seed POST status ${r.status}: ${r.text}`));

		const baselineEmbedCalls = fake.embedCallCount();
		const updatedContent = 'put updated text';

		await request(ctx.harper.httpURL)
			.put('/EmbedDoc/doc-put-source')
			.set(client.headers)
			.send({ id: 'doc-put-source', content: updatedContent })
			.expect((r: any) => ok([200, 204].includes(r.status), `PUT status ${r.status}: ${r.text}`));

		strictEqual(
			fake.embedCallCount(),
			baselineEmbedCalls + 1,
			'embed should fire exactly once on a PUT that includes the source field'
		);

		const expected = deterministicVector(updatedContent);
		const getResp = await client.reqRest('/EmbedDoc/doc-put-source').expect(200);
		const body = getResp.body as { content: string; embedding: unknown };
		strictEqual(body.content, updatedContent);
		const stored = decodeVector(body.embedding);
		ok(stored, `embedding should be populated after PUT, got: ${JSON.stringify(body.embedding)}`);
		for (let i = 0; i < 3; i++) {
			ok(Math.abs(stored[i] - expected[i]) < 1e-5, `PUT vector[${i}] mismatch: ${stored[i]} vs ${expected[i]}`);
		}
	});

	test('replication-receiver: POST with x-replicate-from:none + supplied vector → embedder skipped', async () => {
		const content = 'replicated record content';
		const suppliedVector = [0.111, 0.222, 0.333];
		const baselineEmbedCalls = fake.embedCallCount();

		await request(ctx.harper.httpURL)
			.post('/EmbedDoc/')
			.set({ ...client.headers, 'x-replicate-from': 'none' })
			.send({ id: 'doc-replica', content, embedding: suppliedVector })
			.expect((r: any) => ok([200, 201, 204].includes(r.status), `replica POST status ${r.status}: ${r.text}`));

		strictEqual(
			fake.embedCallCount(),
			baselineEmbedCalls,
			'embed should NOT fire on a write with x-replicate-from: none (receiver context)'
		);

		const getResp = await client.reqRest('/EmbedDoc/doc-replica').expect(200);
		const body = getResp.body as { id: string; content: string; embedding: unknown };
		strictEqual(body.id, 'doc-replica');
		strictEqual(body.content, content);
		const stored = decodeVector(body.embedding);
		ok(stored, `embedding should be populated from supplied vector, got: ${JSON.stringify(body.embedding)}`);
		strictEqual(stored.length, 3);
		// The receiver must preserve the originator's vector — NOT overwrite with what
		// it would have computed locally. Compare against suppliedVector, not against
		// deterministicVector(content).
		for (let i = 0; i < 3; i++) {
			ok(
				Math.abs(stored[i] - suppliedVector[i]) < 1e-5,
				`receiver stored ${stored[i]} but should be the originator's ${suppliedVector[i]}`
			);
		}
	});

	test('caching table with @embed: GET fires source → cache write embeds → vector stored', async () => {
		// GET on a caching-sourced table triggers `getFromSource`; Harper writes the
		// resolved record into the cache via a path that bypasses `_writeUpdate` but
		// still runs the embed hook. This test exercises that path.
		const id = 'cached-1';
		const expectedContent = `derived content for ${id}`;
		const expectedVector = deterministicVector(expectedContent);
		const baselineEmbedCalls = fake.embedCallCount();

		// First GET: cache miss → source resolves → cache write fires embed hook.
		const firstGet = await client.reqRest(`/CachedEmbedDoc/${id}`).expect(200);
		const firstBody = firstGet.body as { id: string; content: string; embedding: unknown };
		strictEqual(firstBody.id, id);
		strictEqual(firstBody.content, expectedContent, 'cache should reflect the source-returned content');

		// The embedder must have run exactly once during the cache write.
		strictEqual(
			fake.embedCallCount(),
			baselineEmbedCalls + 1,
			'embed should fire exactly once when populating a caching table from source'
		);
		const inputs = fake.lastEmbedInputs().at(-1)!;
		ok(
			inputs.some((s) => s.includes(expectedContent)),
			`embed input ${JSON.stringify(inputs)} should reflect the source content`
		);

		// Stored row must have the embedding. The GET response above may not surface the
		// embedding column for sourced-table reads, so verify against an authoritative
		// search_by_hash on the underlying table.
		// `getFromSource` resolves the GET BEFORE the cache write's txn commits (see
		// `Table.ts:~4275` design comment — "we don't want to wait for the transaction").
		// On a slow CI runner the txn commit can land AFTER our next search_by_hash, so
		// poll a few times with a short backoff rather than assert on first read.
		let search: any;
		for (let attempt = 0; attempt < 10; attempt++) {
			search = await client
				.req()
				.send({
					operation: 'search_by_hash',
					database: 'embedtest',
					table: 'CachedEmbedDoc',
					hash_values: [id],
					get_attributes: ['*'],
				})
				.expect(200);
			if (Array.isArray(search.body) && search.body.length === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		ok(Array.isArray(search.body) && search.body.length === 1, `search_by_hash body: ${JSON.stringify(search.body)}`);
		const stored = decodeVector(search.body[0].embedding);
		ok(stored, `embedding should be populated on the cached row, got: ${JSON.stringify(search.body[0].embedding)}`);
		strictEqual(stored.length, 3);
		for (let i = 0; i < 3; i++) {
			ok(
				Math.abs(stored[i] - expectedVector[i]) < 1e-5,
				`cached-row vector[${i}] mismatch: stored=${stored[i]} expected=${expectedVector[i]}`
			);
		}

		// Second GET: cache hit. The embedder must NOT fire again.
		const callsAfterFirst = fake.embedCallCount();
		await client.reqRest(`/CachedEmbedDoc/${id}`).expect(200);
		strictEqual(fake.embedCallCount(), callsAfterFirst, 'cache-hit GET should not re-run the embedder');
	});
});
