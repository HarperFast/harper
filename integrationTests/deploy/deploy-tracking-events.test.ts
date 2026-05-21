/**
 * Deployment tracking — event_log and SSE replay/tail (Slice B1 of issue #641).
 *
 * Builds on the Slice A audit-record tests by exercising the new ProgressEmitter →
 * DeploymentRecorder integration: every successful deploy should populate event_log with
 * the lifecycle phases, and `get_deployment` with `Accept: text/event-stream` should
 * replay those events to the client and close cleanly for a terminal deploy.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from 'node:http';
import { Readable } from 'node:stream';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

import { streamPackagedDirectory } from '../../dist/components/packageComponent.js';
import { buildMultipartBody } from '../../dist/bin/multipartBuilder.js';

function postMultipart(
	url: URL,
	contentType: string,
	body: Readable,
	auth: { username: string; password: string }
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port,
				method: 'POST',
				path: '/',
				headers: {
					'Content-Type': contentType,
					'Transfer-Encoding': 'chunked',
					'Authorization': 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64'),
				},
			},
			(res) => {
				res.setEncoding('utf8');
				let buf = '';
				res.on('data', (chunk) => (buf += chunk));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
			}
		);
		req.on('error', reject);
		body.on('error', reject);
		body.pipe(req);
	});
}

async function callOperation(
	ctx: ContextWithHarper,
	op: Record<string, unknown>,
	headers: Record<string, string> = {}
): Promise<{ status: number; body: any; rawText: string; contentType: string }> {
	const url = new URL(ctx.harper.operationsAPIURL);
	const auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': auth, ...headers },
		body: JSON.stringify(op),
	});
	const text = await res.text();
	let parsed: any = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// SSE responses are line-oriented text; the caller will parse them.
	}
	return { status: res.status, body: parsed, rawText: text, contentType: res.headers.get('content-type') ?? '' };
}

suite('Deployment tracking — events + SSE', (ctx: ContextWithHarper) => {
	let fixtureDir: string;
	let deploymentId: string;

	before(async () => {
		await startHarper(ctx);
		fixtureDir = mkdtempSync(join(tmpdir(), 'deploy-events-fixture-'));
		writeFileSync(
			join(fixtureDir, 'config.yaml'),
			'static:\n  files: web\ngraphqlSchema:\n  files: schema.graphql\nrest: true\n'
		);
		writeFileSync(join(fixtureDir, 'schema.graphql'), 'type Query { hello: String }\n');
		mkdirSync(join(fixtureDir, 'web'), { recursive: true });
		writeFileSync(join(fixtureDir, 'web', 'index.html'), '<h1>Hello, Events!</h1>');
	});

	after(async () => {
		try {
			rmSync(fixtureDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		await teardownHarper(ctx);
	});

	test('verify Harper', async () => {
		const response = await fetch(`${ctx.harper.operationsAPIURL}/health`);
		strictEqual(response.status, 200);
	});

	test('successful deploy populates event_log with the lifecycle phases', async () => {
		const project = 'events-test-application';
		const multipart = buildMultipartBody(
			{ operation: 'deploy_component', project, restart: false },
			{
				name: 'payload',
				filename: 'package.tar.gz',
				contentType: 'application/gzip',
				stream: streamPackagedDirectory(fixtureDir, { skip_node_modules: true }),
			}
		);
		const url = new URL(ctx.harper.operationsAPIURL);
		const response = await postMultipart(url, multipart.contentType, multipart.stream, ctx.harper.admin);
		strictEqual(response.status, 200, `expected 200, got ${response.status}: ${response.body}`);
		const result = JSON.parse(response.body);
		deploymentId = result.deployment_id;
		ok(deploymentId, 'deploy response should include deployment_id');

		// Coalesced writes settle on a microtask boundary; give them a beat.
		await sleep(200);

		const got = await callOperation(ctx, { operation: 'get_deployment', deployment_id: deploymentId });
		strictEqual(got.status, 200);
		const row = got.body;
		ok(Array.isArray(row.event_log), 'event_log should be an array');
		ok(row.event_log.length >= 2, `expected at least 2 events, got ${row.event_log.length}`);
		const phases = row.event_log.filter((e: any) => e.event === 'phase').map((e: any) => e.data?.phase);
		// We emit prepare → (load) → replicate → success in the lifecycle. Verify the spine.
		ok(phases.includes('prepare'), `event_log should include a prepare phase: ${phases.join(',')}`);
		ok(phases.includes('replicate'), `event_log should include a replicate phase: ${phases.join(',')}`);
	});

	test('get_deployment with Accept: text/event-stream replays event_log and closes cleanly', async () => {
		// Already terminal at this point — Slice B1's SSE branch should replay event_log
		// then return the final record as the `done` event.
		const got = await callOperation(
			ctx,
			{ operation: 'get_deployment', deployment_id: deploymentId },
			{ Accept: 'text/event-stream' }
		);
		strictEqual(got.status, 200, `expected 200, got ${got.status}: ${got.rawText}`);
		ok(got.contentType.startsWith('text/event-stream'), `expected SSE content-type, got: ${got.contentType}`);

		const text = got.rawText;
		// Each SSE record is separated by a blank line. Count phase events.
		const records = text.split(/\r?\n\r?\n/).filter((r) => r.includes('event:'));
		ok(
			records.length >= 2,
			`expected at least 2 SSE records (events + done), got ${records.length}.\nraw SSE:\n${text}`
		);
		ok(
			records.some((r) => r.includes('event: phase')),
			`expected at least one phase event in SSE replay.\nraw SSE:\n${text}`
		);
		ok(
			records.some((r) => r.includes('event: done')),
			`expected a final done event in SSE replay.\nraw SSE:\n${text}`
		);
	});

	test('failed deploy event_log captures the error event', async () => {
		const project = 'broken-events-application';
		const brokenDir = mkdtempSync(join(tmpdir(), 'broken-events-fixture-'));
		try {
			writeFileSync(
				join(brokenDir, 'package.json'),
				JSON.stringify({ name: project, version: '0.0.0', dependencies: {} })
			);
			writeFileSync(join(brokenDir, 'config.yaml'), 'rest: true\n');
			const multipart = buildMultipartBody(
				{
					operation: 'deploy_component',
					project,
					restart: false,
					install_command: 'sh -c "exit 1"',
					install_timeout: 30_000,
				},
				{
					name: 'payload',
					filename: 'package.tar.gz',
					contentType: 'application/gzip',
					stream: streamPackagedDirectory(brokenDir, { skip_node_modules: true }),
				}
			);
			const url = new URL(ctx.harper.operationsAPIURL);
			const response = await postMultipart(url, multipart.contentType, multipart.stream, ctx.harper.admin);
			ok(response.status >= 400, `expected an error response, got ${response.status}`);

			await sleep(200);
			const listed = await callOperation(ctx, { operation: 'list_deployments', project });
			const failed = listed.body.deployments.find((d: any) => d.project === project);
			ok(failed, 'expected to find a failed deployment row');
			strictEqual(failed.status, 'failed');
			const errorEvents = (failed.event_log ?? []).filter((e: any) => e.event === 'error');
			ok(errorEvents.length >= 1, 'expected at least one error event in event_log');
		} finally {
			try {
				rmSync(brokenDir, { recursive: true, force: true });
			} catch {}
		}
	});
});
