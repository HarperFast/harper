/**
 * Deployment tracking integration test (Slice A of issue #641).
 *
 * Asserts that every deploy_component call now writes a row to system.hdb_deployment,
 * that the row contains a populated payload_hash + payload_size, that list_deployments
 * and get_deployment surface the row through the operations API, and that a failed
 * deploy produces a row with status=failed and a populated error field.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
					Authorization: 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`).toString('base64'),
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
	op: Record<string, unknown>
): Promise<{ status: number; body: any }> {
	const url = new URL(ctx.harper.operationsAPIURL);
	const auth =
		'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: auth },
		body: JSON.stringify(op),
	});
	const text = await res.text();
	let parsed: any = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// leave as text
	}
	return { status: res.status, body: parsed };
}

suite('Deployment tracking', (ctx: ContextWithHarper) => {
	let fixtureDir: string;
	let deploymentId: string | undefined;

	before(async () => {
		await startHarper(ctx);
		fixtureDir = mkdtempSync(join(tmpdir(), 'deploy-tracking-fixture-'));
		writeFileSync(
			join(fixtureDir, 'config.yaml'),
			'static:\n  files: web\ngraphqlSchema:\n  files: schema.graphql\nrest: true\n'
		);
		writeFileSync(join(fixtureDir, 'schema.graphql'), 'type Query { hello: String }\n');
		mkdirSync(join(fixtureDir, 'web'), { recursive: true });
		writeFileSync(join(fixtureDir, 'web', 'index.html'), '<h1>Hello, Tracking!</h1>');
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

	test('deploy records a hdb_deployment row with hash, size, and success status', async () => {
		const project = 'tracking-test-application';
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
		ok(result.deployment_id, 'deploy response should include a deployment_id');
		ok(/^[0-9a-f-]{36}$/i.test(result.deployment_id), `deployment_id should be a UUID: ${result.deployment_id}`);
		deploymentId = result.deployment_id;

		await sleep(200); // give the table commit a moment to settle if put is async

		const got = await callOperation(ctx, { operation: 'get_deployment', deployment_id: result.deployment_id });
		strictEqual(got.status, 200, `get_deployment should return 200, got ${got.status}: ${JSON.stringify(got.body)}`);
		const row = got.body;
		strictEqual(row.deployment_id, result.deployment_id);
		strictEqual(row.project, project);
		strictEqual(row.status, 'success');
		strictEqual(row.payload_blob_present, true, 'payload_blob should have been persisted');
		ok(typeof row.payload_hash === 'string' && /^[0-9a-f]{64}$/i.test(row.payload_hash), 'payload_hash should be a sha256 hex string');
		ok(typeof row.payload_size === 'number' && row.payload_size > 0, 'payload_size should be a positive integer');
		ok(typeof row.started_at === 'number' && row.started_at > 0, 'started_at should be set');
		ok(typeof row.completed_at === 'number' && row.completed_at >= row.started_at, 'completed_at should be >= started_at');
	});

	test('list_deployments surfaces the row, supports project filter', async () => {
		const project = 'tracking-test-application';
		const listed = await callOperation(ctx, { operation: 'list_deployments', project });
		strictEqual(listed.status, 200);
		ok(listed.body.total >= 1, `expected at least 1 deployment, got ${listed.body.total}`);
		const ids = listed.body.deployments.map((d: any) => d.deployment_id);
		ok(deploymentId && ids.includes(deploymentId), `listed deployments should include ${deploymentId}`);
		// blob bytes must NOT travel back in the list response — only the presence boolean.
		ok(!('payload_blob' in listed.body.deployments[0]), 'list_deployments must not include payload_blob bytes');
		ok('payload_blob_present' in listed.body.deployments[0], 'list_deployments should include payload_blob_present flag');
	});

	test('a failed deploy is recorded with status=failed and error.message', async () => {
		const project = 'broken-tracking-application';
		const brokenDir = mkdtempSync(join(tmpdir(), 'broken-fixture-'));
		try {
			// A package.json so install runs; a guaranteed-failing install_command forces the
			// deploy lifecycle into its catch block. Recorder.finish('failed', err) must still
			// commit a row with status=failed and a populated error.message.
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
			// The HTTP response will be non-200 (error), but the row must still exist.
			ok(response.status >= 400, `expected an error response, got ${response.status}: ${response.body}`);

			await sleep(200);

			const listed = await callOperation(ctx, { operation: 'list_deployments', project });
			strictEqual(listed.status, 200);
			const failed = listed.body.deployments.find((d: any) => d.project === project);
			ok(failed, `expected to find a deployment for ${project} in list`);
			strictEqual(failed.status, 'failed');
			ok(failed.error && typeof failed.error.message === 'string' && failed.error.message.length > 0, 'failed deployment should have error.message');
		} finally {
			try {
				rmSync(brokenDir, { recursive: true, force: true });
			} catch {}
		}
	});
});
