// `@decide` end to end against a fake Ollama that serves `/api/chat` and `/api/embed`.
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/lifecycle.mjs has no type declarations; runtime resolves fine
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';
import request from 'supertest';

const SAMPLES = 4;

const SCHEMA_GRAPHQL = [
	'type Ticket @table(database: "decidetest") @sealed @export {',
	'\tid: ID! @primaryKey',
	'\tbody: String',
	'\ttag: String',
	'\troute: String @decide(source: "body", values: ["billing", "refund", "bug", "other"], model: "default", confidence: "routeConfidence")',
	'\trouteConfidence: Float @indexed',
	'\turgent: Boolean @decide(source: "body", confidence: "urgentConfidence")',
	'\turgentConfidence: Float',
	'\tseverity: Int @decide(source: "body", minimum: 1, maximum: 5, confidence: "severityConfidence")',
	'\tseverityConfidence: Float',
	'\tembedding: [Float] @embed(source: "body", model: "default")',
	'}',
	'',
	'type CachedTicket @table(database: "decidetest") @sealed @export {',
	'\tid: ID! @primaryKey',
	'\tbody: String',
	'\troute: String @decide(source: "body", values: ["billing", "refund", "bug", "other"], confidence: "routeConfidence")',
	'\trouteConfidence: Float',
	'}',
	'',
].join('\n');

const RESOURCES_JS = [
	'const { CachedTicket } = databases.decidetest;',
	'',
	'export class CachedTicketSource extends Resource {',
	'\tasync get() {',
	'\t\tconst id = this.getId();',
	'\t\treturn { id, body: `bug report ${id}` };',
	'\t}',
	'}',
	'',
	'CachedTicket.sourcedFrom(CachedTicketSource);',
	'',
].join('\n');

interface FakeOllama {
	host: string;
	close: () => Promise<void>;
	chatCallCount: () => number;
	embedCallCount: () => number;
	reset: () => void;
}

const DECISIONS_PER_WRITE = 3;

// A "refund" body gets one dissenting vote per SAMPLES calls, so its stored confidence is exactly 0.75.
function answer(prompt: string, callIndexForBody: number): string {
	const body = prompt.slice(prompt.lastIndexOf('Input:\n') + 'Input:\n'.length);
	if (body.includes('garbage')) return 'I cannot decide.';
	if (prompt.includes('an integer from 1 to 5')) return JSON.stringify({ value: body.includes('urgent') ? 5 : 2 });
	if (!prompt.includes('"billing"')) return JSON.stringify({ value: body.includes('urgent') });
	if (body.includes('refund'))
		return JSON.stringify({ value: callIndexForBody % SAMPLES === SAMPLES - 1 ? 'billing' : 'refund' });
	if (body.includes('bug')) return JSON.stringify({ value: 'bug' });
	if (body.includes('invoice')) return JSON.stringify({ value: 'billing' });
	return JSON.stringify({ value: 'other' });
}

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
	return [h1 / 9973, h2 / 9967, h3 / 9941];
}

async function startFakeOllama(): Promise<FakeOllama> {
	let chatCalls = 0;
	let embedCalls = 0;
	const callsPerKey = new Map<string, number>();
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method === 'POST' && req.url === '/api/embed') {
			let raw = '';
			req.on('data', (chunk) => (raw += chunk));
			req.on('end', () => {
				const parsed = JSON.parse(raw) as { input: string | string[] };
				const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
				embedCalls++;
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ embeddings: inputs.map(deterministicVector), prompt_eval_count: 3 }));
			});
			return;
		}
		if (req.method === 'POST' && req.url === '/api/chat') {
			let raw = '';
			req.on('data', (chunk) => (raw += chunk));
			req.on('end', () => {
				try {
					const parsed = JSON.parse(raw) as { messages: { role: string; content: string }[] };
					const prompt = parsed.messages.map((m) => m.content).join('\n');
					chatCalls++;
					const key = prompt.slice(prompt.indexOf('Decide "value"'));
					const index = callsPerKey.get(key) ?? 0;
					callsPerKey.set(key, index + 1);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(
						JSON.stringify({
							message: { role: 'assistant', content: answer(prompt, index) },
							done: true,
							done_reason: 'stop',
							prompt_eval_count: 12,
							eval_count: 6,
						})
					);
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
	return {
		host: `127.0.0.1:${addr.port}`,
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
		chatCallCount: () => chatCalls,
		embedCallCount: () => embedCalls,
		reset: () => {
			chatCalls = 0;
			embedCalls = 0;
			callsPerKey.clear();
		},
	};
}

suite('@decide directive end-to-end with fake Ollama', (ctx: any) => {
	let fake: FakeOllama;
	let client: any;

	const post = (path: string, body: object, headers: object = {}) =>
		request(ctx.harper.httpURL)
			.post(path)
			.set({ ...client.headers, ...headers })
			.send(body);

	before(async () => {
		fake = await startFakeOllama();
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
					generative: {
						default: { backend: 'ollama', host: fake.host, model: 'fake-gen' },
					},
					decision: {
						default: { backend: 'generative', samples: SAMPLES, concurrency: 2 },
					},
				},
			},
			env: {},
		});
		client = createApiClient(ctx.harper);

		await client
			.req()
			.send({ operation: 'add_component', project: 'decidetest' })
			.expect((r: any) => {
				const text = JSON.stringify(r.body);
				ok(text.includes('Successfully added project') || text.includes('Project already exists'), r.text);
			});
		await client
			.req()
			.send({ operation: 'set_component_file', project: 'decidetest', file: 'schema.graphql', payload: SCHEMA_GRAPHQL })
			.expect((r: any) => ok(r.body?.message?.includes?.('Successfully set component: schema.graphql'), r.text))
			.expect(200);
		await client
			.req()
			.send({ operation: 'set_component_file', project: 'decidetest', file: 'resources.js', payload: RESOURCES_JS })
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

	test('schema with @decide creates the Ticket table and describe surfaces the directive', async () => {
		const desc = await client.req().send({ operation: 'describe_all' }).expect(200);
		const ticket = desc.body?.decidetest?.Ticket;
		ok(ticket, 'Ticket table not created');
		const route = (ticket.attributes || []).find((a: any) => a.attribute === 'route');
		ok(route?.decide, 'describe should surface the @decide config');
		strictEqual(route.decide.source, 'body');
		strictEqual(route.decide.model, 'default');
		strictEqual(route.decide.confidence, 'routeConfidence');
		strictEqual(JSON.stringify(route.decide.schema), JSON.stringify({ enum: ['billing', 'refund', 'bug', 'other'] }));
		const urgent = (ticket.attributes || []).find((a: any) => a.attribute === 'urgent');
		strictEqual(JSON.stringify(urgent?.decide?.schema), JSON.stringify({ type: 'boolean' }));
		const severity = (ticket.attributes || []).find((a: any) => a.attribute === 'severity');
		strictEqual(JSON.stringify(severity?.decide?.schema), JSON.stringify({ type: 'integer', minimum: 1, maximum: 5 }));
		const confidence = (ticket.attributes || []).find((a: any) => a.attribute === 'routeConfidence');
		ok(confidence?.indexed, 'the confidence attribute keeps its explicit index');
	});

	test('happy path: POST → every decision samples the model, the embedding is computed → all pairs stored', async () => {
		fake.reset();
		const text = 'please refund my order, it is urgent';
		await post('/Ticket/', { id: 't-refund', body: text }).expect((r: any) =>
			ok([200, 201, 204].includes(r.status), `unexpected status ${r.status}: ${r.text}`)
		);
		strictEqual(fake.chatCallCount(), DECISIONS_PER_WRITE * SAMPLES, 'each decision samples the model SAMPLES times');
		strictEqual(fake.embedCallCount(), 1, 'the @embed attribute on the same table is computed once, alongside');

		const body = (await client.reqRest('/Ticket/t-refund').expect(200)).body;
		strictEqual(body.route, 'refund');
		strictEqual(body.routeConfidence, 0.75, 'three of four votes');
		strictEqual(body.urgent, true);
		strictEqual(body.urgentConfidence, 1);
		strictEqual(body.severity, 5, 'the Int leaf round-trips through the generative prompt');
		strictEqual(body.severityConfidence, 1);
		const expected = deterministicVector(text);
		ok(Array.isArray(body.embedding) && body.embedding.length === 3, `embedding: ${JSON.stringify(body.embedding)}`);
		for (let i = 0; i < 3; i++) ok(Math.abs(body.embedding[i] - expected[i]) < 1e-5, `embedding[${i}]`);
	});

	test('PATCH of an unrelated field does not call the model; the stored pair survives', async () => {
		await post('/Ticket/', { id: 't-patch', body: 'invoice question' }).expect((r: any) =>
			ok([200, 201, 204].includes(r.status), `seed POST status ${r.status}: ${r.text}`)
		);
		const baseline = fake.chatCallCount();
		await request(ctx.harper.httpURL)
			.patch('/Ticket/t-patch')
			.set(client.headers)
			.send({ tag: 'triaged' })
			.expect((r: any) => ok([200, 204].includes(r.status), `PATCH status ${r.status}: ${r.text}`));
		strictEqual(fake.chatCallCount(), baseline, 'no model call when the source is not in the PATCH payload');
		const body = (await client.reqRest('/Ticket/t-patch').expect(200)).body;
		strictEqual(body.tag, 'triaged');
		strictEqual(body.route, 'billing');
		strictEqual(body.routeConfidence, 1);
	});

	test('PATCH of the source field decides again; the pair reflects the new body', async () => {
		await post('/Ticket/', { id: 't-source-patch', body: 'invoice question' }).expect((r: any) =>
			ok([200, 201, 204].includes(r.status), `seed POST status ${r.status}: ${r.text}`)
		);
		const baseline = fake.chatCallCount();
		await request(ctx.harper.httpURL)
			.patch('/Ticket/t-source-patch')
			.set(client.headers)
			.send({ body: 'this is a bug' })
			.expect((r: any) => ok([200, 204].includes(r.status), `PATCH status ${r.status}: ${r.text}`));
		strictEqual(
			fake.chatCallCount(),
			baseline + DECISIONS_PER_WRITE * SAMPLES,
			'every decision runs again on a source PATCH'
		);
		const body = (await client.reqRest('/Ticket/t-source-patch').expect(200)).body;
		strictEqual(body.body, 'this is a bug');
		strictEqual(body.route, 'bug');
		strictEqual(body.routeConfidence, 1);
		strictEqual(body.urgent, false);
		strictEqual(body.severity, 2);
	});

	test('replication receiver: x-replicate-from: none with a supplied pair → no model call, pair stored as-is', async () => {
		const baseline = fake.chatCallCount();
		await post(
			'/Ticket/',
			{
				id: 't-replica',
				body: 'please refund',
				route: 'other',
				routeConfidence: 0.125,
				urgent: true,
				urgentConfidence: 0.5,
			},
			{ 'x-replicate-from': 'none' }
		).expect((r: any) => ok([200, 201, 204].includes(r.status), `replica POST status ${r.status}: ${r.text}`));
		strictEqual(fake.chatCallCount(), baseline, 'no model call on a receiver-context write');
		const body = (await client.reqRest('/Ticket/t-replica').expect(200)).body;
		strictEqual(body.route, 'other', "the receiver keeps the originator's value");
		strictEqual(body.routeConfidence, 0.125);
		strictEqual(body.urgent, true);
		strictEqual(body.urgentConfidence, 0.5);
	});

	test('a review queue is a range condition on the indexed confidence attribute', async () => {
		const search = await client
			.req()
			.send({
				operation: 'search_by_conditions',
				database: 'decidetest',
				table: 'Ticket',
				conditions: [{ search_attribute: 'routeConfidence', search_type: 'less_than', search_value: 0.8 }],
				get_attributes: ['id', 'route', 'routeConfidence'],
			})
			.expect(200);
		const ids = (search.body as any[]).map((row) => row.id).sort();
		strictEqual(JSON.stringify(ids), JSON.stringify(['t-refund', 't-replica']), JSON.stringify(search.body));
	});

	test('a decision the model cannot make fails the write as a whole and stores nothing', async () => {
		const res = await post('/Ticket/', { id: 't-garbage', body: 'garbage in' });
		ok(res.status >= 400, `expected a failed POST, got ${res.status}: ${res.text}`);
		ok(!/127\.0\.0\.1/.test(res.text), 'the client error must not carry the backend host');
		await client.reqRest('/Ticket/t-garbage').expect(404);
	});

	test('caching table with @decide: GET fires source → cache write decides → pair stored', async () => {
		const id = 'cached-1';
		const baseline = fake.chatCallCount();
		const first = (await client.reqRest(`/CachedTicket/${id}`).expect(200)).body;
		strictEqual(first.body, `bug report ${id}`);
		for (let attempt = 0; attempt < 40 && fake.chatCallCount() < baseline + SAMPLES; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		strictEqual(fake.chatCallCount(), baseline + SAMPLES, 'the cache fill decides once');
		let search: any;
		for (let attempt = 0; attempt < 20; attempt++) {
			search = await client
				.req()
				.send({
					operation: 'search_by_hash',
					database: 'decidetest',
					table: 'CachedTicket',
					hash_values: [id],
					get_attributes: ['*'],
				})
				.expect(200);
			if (Array.isArray(search.body) && search.body.length === 1 && search.body[0].route) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		ok(Array.isArray(search.body) && search.body.length === 1, `search_by_hash body: ${JSON.stringify(search.body)}`);
		strictEqual(search.body[0].route, 'bug');
		strictEqual(search.body[0].routeConfidence, 1);
		const callsAfterFirst = fake.chatCallCount();
		await client.reqRest(`/CachedTicket/${id}`).expect(200);
		strictEqual(fake.chatCallCount(), callsAfterFirst, 'a cache hit does not decide again');
	});
});
