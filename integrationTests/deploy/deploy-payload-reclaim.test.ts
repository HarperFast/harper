/**
 * Large-payload reclamation integration test.
 *
 * After a successful deploy, a payload whose size exceeds deployment_payloadRetention_maxSize
 * has its payload_blob dropped from the hdb_deployment row (the bytes dwarf the metadata and
 * every peer has already installed from the blob). The metadata — payload_size, payload_hash,
 * event_log, status — is retained for the audit trail.
 *
 * The threshold is forced to 1 byte here so the small test fixture trips it; the retain side
 * (a payload below the default 10 MiB threshold keeps its blob) is covered by
 * deploy-tracking.test.ts, which deploys the same kind of small fixture under the default
 * configuration and asserts payload_blob_present === true.
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
	op: Record<string, unknown>
): Promise<{ status: number; body: any }> {
	const url = new URL(ctx.harper.operationsAPIURL);
	const auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': auth },
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

// Poll get_deployment until the row reaches a terminal status rather than relying on a fixed
// sleep — the terminal commit settles asynchronously and a hardcoded timer is a flake source.
async function getDeploymentWhenTerminal(ctx: ContextWithHarper, deploymentId: string, timeoutMs = 5000): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	let last: any;
	while (Date.now() < deadline) {
		const got = await callOperation(ctx, { operation: 'get_deployment', deployment_id: deploymentId });
		last = got;
		if (got.status === 200 && (got.body?.status === 'success' || got.body?.status === 'failed')) return got;
		await sleep(50);
	}
	return last;
}

suite('Deployment payload reclamation', (ctx: ContextWithHarper) => {
	let fixtureDir: string;

	before(async () => {
		// Force the retention threshold to 1 byte so any real payload trips the drop. The
		// harness applies this via HARPER_SET_CONFIG (flattened to deployment.payloadRetention.maxSize).
		// Pass it as a string so this also exercises getPayloadRetentionMaxSize's numeric-string
		// coercion — the shape an env-var/string-sourced override actually arrives in.
		await startHarper(ctx, {
			config: { deployment: { payloadRetention: { maxSize: '1' } } },
			env: {},
		});
		fixtureDir = mkdtempSync(join(tmpdir(), 'deploy-reclaim-fixture-'));
		writeFileSync(join(fixtureDir, 'config.yaml'), 'static:\n  files: web\nrest: true\n');
		mkdirSync(join(fixtureDir, 'web'), { recursive: true });
		writeFileSync(join(fixtureDir, 'web', 'index.html'), '<h1>Hello, Reclaim!</h1>');
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

	test('drops payload_blob after a successful deploy that exceeds the threshold, retaining metadata', async () => {
		const project = 'reclaim-test-application';
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

		const got = await getDeploymentWhenTerminal(ctx, result.deployment_id);
		strictEqual(got.status, 200, `get_deployment should return 200: ${JSON.stringify(got.body)}`);
		const row = got.body;
		strictEqual(row.status, 'success');
		strictEqual(row.payload_blob_present, false, 'payload_blob should have been dropped post-deploy');
		ok(typeof row.payload_size === 'number' && row.payload_size > 0, 'payload_size metadata should be retained');
		ok(
			typeof row.payload_hash === 'string' && /^[0-9a-f]{64}$/i.test(row.payload_hash),
			'payload_hash metadata should be retained'
		);
		ok(
			Array.isArray(row.event_log) && row.event_log.some((e: any) => e.event === 'payload_dropped'),
			'event_log should record a payload_dropped event for the audit trail'
		);

		// The component itself must still be deployed — reclaiming the upload tarball must not
		// affect the extracted, running component.
		const components = await callOperation(ctx, { operation: 'get_components' });
		strictEqual(components.status, 200);
	});
});
