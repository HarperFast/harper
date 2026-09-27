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

const VALUES = ['billing', 'refund', 'bug'];
const RECORDED = 120;

// Case i: the truth cycles through the values, and every vote names the model's answer, which is right 60% of the
// time. The votes are unanimous, so the raw probability is far more confident than the answers are accurate.
const RESOURCES_JS = [
	"import { models } from 'harper';",
	`const VALUES = ${JSON.stringify(VALUES)};`,
	'const SCHEMA = { enum: VALUES };',
	'const truthOf = (i) => VALUES[i % 3];',
	'',
	'export class Calibration extends Resource {',
	'\tstatic loadAsInstance = false;',
	'\tasync post(_query, body) {',
	"\t\tif (body.action === 'record') {",
	'\t\t\tfor (let i = body.from; i < body.to; i++) {',
	'\t\t\t\tconst d = await models.decide(`case-${i}`, SCHEMA, { persist: true });',
	"\t\t\t\tawait models.recordOutcome(d.id, { truth: { kind: 'value', value: truthOf(i) } });",
	'\t\t\t}',
	'\t\t\treturn { recorded: body.to - body.from };',
	'\t\t}',
	"\t\tif (body.action === 'calibrate') return models.calibrate();",
	"\t\tif (body.action === 'calibrations') return models.getCalibrations();",
	"\t\tif (body.action === 'decide') {",
	'\t\t\tfor (let attempt = 0; attempt < 40; attempt++) {',
	'\t\t\t\tconst d = await models.decide(body.state, SCHEMA, { persist: true });',
	'\t\t\t\tif (d.calibrated) return { attempts: attempt + 1, decision: d, record: await models.getDecision(d.id) };',
	'\t\t\t\tawait new Promise((resolve) => setTimeout(resolve, 50));',
	'\t\t\t}',
	'\t\t\treturn { attempts: 40, decision: await models.decide(body.state, SCHEMA) };',
	'\t\t}',
	'\t}',
	'}',
	'',
].join('\n');

function answerFor(prompt: string): string {
	const i = Number(/case-(\d+)/.exec(prompt)?.[1] ?? 0);
	const truth = VALUES[i % 3];
	return JSON.stringify({ value: i % 5 < 3 ? truth : VALUES[(i + 1) % 3] });
}

async function startFakeOllama(): Promise<{ host: string; close: () => Promise<void> }> {
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== 'POST' || req.url !== '/api/chat') {
			res.writeHead(404);
			res.end();
			return;
		}
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			const parsed = JSON.parse(raw) as { messages: { content: string }[] };
			const prompt = parsed.messages.map((m) => m.content).join('\n');
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					message: { role: 'assistant', content: answerFor(prompt) },
					done: true,
					done_reason: 'stop',
					prompt_eval_count: 4,
					eval_count: 2,
				})
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const addr = server.address() as AddressInfo;
	return {
		host: `127.0.0.1:${addr.port}`,
		close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
	};
}

suite('decide calibration end-to-end (#2841)', (ctx: any) => {
	let fake: { host: string; close: () => Promise<void> };
	let client: any;

	const post = (body: object) => request(ctx.harper.httpURL).post('/Calibration/').set(client.headers).send(body);

	before(async () => {
		fake = await startFakeOllama();
		if (process.env.HARPER_INTEGRATION_TEST_FORCE_LOOPBACK) {
			ctx.harper = { ...ctx.harper, hostname: '127.0.0.1' };
		}
		await startHarper(ctx, {
			config: {
				models: {
					generative: { default: { backend: 'ollama', host: fake.host, model: 'fake-gen' } },
					decision: { default: { backend: 'generative', samples: 3, concurrency: 3, scoring: 'vote' } },
					calibration: { minReport: 10, minTrain: 60, minHeldOut: 30, heldOutShare: 0.3, eceMargin: 0.01 },
				},
			},
			env: {},
		});
		client = createApiClient(ctx.harper);
		await client
			.req()
			.send({ operation: 'add_component', project: 'calibrationtest' })
			.expect((r: any) => {
				const text = JSON.stringify(r.body);
				ok(text.includes('Successfully added project') || text.includes('Project already exists'), r.text);
			});
		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: 'calibrationtest',
				file: 'resources.js',
				payload: RESOURCES_JS,
			})
			.expect((r: any) => ok(r.body?.message?.includes?.('Successfully set component: resources.js'), r.text))
			.expect(200);
		await restartHttpWorkers(client, '/openapi');
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			await fake.close();
		}
	});

	test('records outcomes, fits, and returns a later decision calibrated with the same value', async () => {
		const recorded = await post({ action: 'record', from: 0, to: RECORDED }).expect(200);
		strictEqual(recorded.body.recorded, RECORDED);

		const run = (await post({ action: 'calibrate' }).expect(200)).body;
		strictEqual(run.status, 'completed', JSON.stringify(run));
		strictEqual(run.written, 1, JSON.stringify(run));
		strictEqual(run.eligible, 1, JSON.stringify(run));

		const state = 'case-1000';
		const decided = (await post({ action: 'decide', state }).expect(200)).body;
		ok(decided.decision.calibrated, `a later decision is calibrated: ${JSON.stringify(decided)}`);
		strictEqual(decided.decision.value, JSON.parse(answerFor(state)).value, 'calibration never changes the value');
		ok(decided.decision.probability < 0.9, `the unanimous vote is softened: ${decided.decision.probability}`);
		strictEqual(decided.record.calibrated, true);
		ok(Array.isArray(decided.record.rawDistribution), 'the recorded row keeps the raw scores');
		strictEqual(decided.record.calibration.length, 1, 'and names the version it applied');
		ok(/;source=[0-9a-f]{64}$/.test(decided.record.signature), decided.record.signature);

		const [summary] = (await post({ action: 'calibrations' }).expect(200)).body;
		strictEqual(summary.eligible, true);
		strictEqual(summary.applied, true);
		ok(summary.report.calibrated.ece < summary.report.raw.ece, JSON.stringify(summary.report));
		ok(summary.report.calibrated.conditional.every((point: any) => 'riskUpper' in point));
	});
});
