/**
 * `@decide` directive integration test, the sibling of embed-directive.test.ts.
 *
 * Spins up a fake Ollama HTTP server inside the test, points Harper's models config at
 * it (a generative logical name over fake `/api/chat`, and the built-in `generative`
 * decision adapter over that), deploys a schema with `@decide`, and exercises:
 *
 *   1. **Schema** — describe surfaces the parsed `@decide` config and the resolved leaf.
 *   2. **Happy path** — POST a record → the adapter samples the fake model → the chosen
 *      value and its vote fraction land on the decorated field and its confidence field.
 *   3. **Source-unchanged PATCH** — no model call; the stored pair survives patch-merge.
 *   4. **Source-changing PATCH** — the model is sampled again; the pair reflects the new body.
 *   5. **Replication-receiver skip** — `x-replicate-from: none` with a supplied pair → no
 *      model call; the supplied pair is stored as-is.
 *   6. **Indexed confidence query** — a review queue is an ordinary range condition on the
 *      confidence field.
 *   7. **Failure atomicity** — a body the fake answers with junk fails the POST and stores
 *      nothing.
 *   8. **Caching-table `@decide`** — the cache-from-source write also decides.
 *
 * The fake answers deterministically from the body text, and gives one dissenting vote per
 * four samples for a "refund" body, so the stored confidence is exactly 0.75.
 */
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
	reset: () => void;
}

/**
 * The fake model answers from the body text in the prompt. A "refund" body gets one
 * dissenting "billing" vote per SAMPLES calls; "garbage" bodies get prose with no JSON
 * object; anything else routes by keyword with full agreement. Urgency is decided by
 * the word "urgent".
 */
function answer(prompt: string, callIndexForBody: number): string {
	const body = prompt.slice(prompt.lastIndexOf('Input:\n') + 'Input:\n'.length);
	const isRoute = prompt.includes('"billing"');
	if (body.includes('garbage')) return 'I cannot decide.';
	if (!isRoute) return JSON.stringify({ value: body.includes('urgent') });
	if (body.includes('refund'))
		return JSON.stringify({ value: callIndexForBody % SAMPLES === SAMPLES - 1 ? 'billing' : 'refund' });
	if (body.includes('bug')) return JSON.stringify({ value: 'bug' });
	if (body.includes('invoice')) return JSON.stringify({ value: 'billing' });
	return JSON.stringify({ value: 'other' });
}

async function startFakeOllama(): Promise<FakeOllama> {
	let chatCalls = 0;
	const callsPerKey = new Map<string, number>();
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method === 'POST' && req.url === '/api/chat') {
			let raw = '';
			req.on('data', (chunk) => (raw += chunk));
			req.on('end', () => {
				try {
					const parsed = JSON.parse(raw) as { messages: { role: string; content: string }[] };
					const prompt = parsed.messages.map((m) => m.content).join('\n');
					chatCalls++;
					const key = prompt.includes('"billing"') + prompt.slice(prompt.lastIndexOf('Input:\n'));
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
		reset: () => {
			chatCalls = 0;
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
		const confidence = (ticket.attributes || []).find((a: any) => a.attribute === 'routeConfidence');
		ok(confidence?.indexed, 'the confidence attribute keeps its explicit index');
	});

	test('happy path: POST → adapter samples the model → value and vote fraction stored', async () => {
		fake.reset();
		await post('/Ticket/', { id: 't-refund', body: 'please refund my order, it is urgent' }).expect((r: any) =>
			ok([200, 201, 204].includes(r.status), `unexpected status ${r.status}: ${r.text}`)
		);
		strictEqual(fake.chatCallCount(), 2 * SAMPLES, 'each of the two decisions samples the model SAMPLES times');

		const body = (await client.reqRest('/Ticket/t-refund').expect(200)).body;
		strictEqual(body.route, 'refund');
		strictEqual(body.routeConfidence, 0.75, 'three of four votes');
		strictEqual(body.urgent, true);
		strictEqual(body.urgentConfidence, 1);
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
		strictEqual(fake.chatCallCount(), baseline + 2 * SAMPLES, 'both decisions run again on a source PATCH');
		const body = (await client.reqRest('/Ticket/t-source-patch').expect(200)).body;
		strictEqual(body.body, 'this is a bug');
		strictEqual(body.route, 'bug');
		strictEqual(body.routeConfidence, 1);
		strictEqual(body.urgent, false);
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
