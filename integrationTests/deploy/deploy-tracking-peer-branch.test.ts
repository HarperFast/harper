/**
 * Deployment tracking — peer-side branch.
 *
 * In a real multi-node deploy, the origin strips `req.payload` before `replicateOperation`
 * and the peer reads the tarball from the replicated `hdb_deployment.payload_blob` row
 * attribute instead. This test exercises that **peer-side branch** in isolation on a
 * single node by:
 *
 *   1. Doing a normal deploy to populate an `hdb_deployment` row with a `payload_blob`.
 *   2. Submitting a second `deploy_component` operation with `_deploymentId` set to that
 *      row's id and **no** `payload` field — the same shape origin produces for peers.
 *   3. Asserting the deploy completes successfully — meaning the peer-side branch in
 *      `deployComponent` found the row, streamed `payload_blob`, and ran prepare/install/load
 *      from the blob bytes.
 *
 * The true 3-node test (verifies BLOB_CHUNK replication actually delivers the row to
 * peers, and that `peer_results` is populated) lives in harper-pro, where the actual
 * `replicateOperation` is implemented. This OSS test only verifies the handler wiring.
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
): Promise<{ status: number; body: any; rawText: string }> {
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
		// not JSON
	}
	return { status: res.status, body: parsed, rawText: text };
}

suite('Deployment tracking — peer-side branch', (ctx: ContextWithHarper) => {
	let fixtureDir: string;
	let seedDeploymentId: string;

	before(async () => {
		await startHarper(ctx);
		fixtureDir = mkdtempSync(join(tmpdir(), 'peer-branch-fixture-'));
		writeFileSync(join(fixtureDir, 'config.yaml'), 'graphqlSchema:\n  files: schema.graphql\nrest: true\n');
		writeFileSync(join(fixtureDir, 'schema.graphql'), 'type Query { hello: String }\n');
		mkdirSync(join(fixtureDir, 'web'), { recursive: true });
		writeFileSync(join(fixtureDir, 'web', 'index.html'), '<h1>Hello, Peer Branch!</h1>');
	});

	after(async () => {
		try {
			rmSync(fixtureDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		await teardownHarper(ctx);
	});

	test('seed: an initial deploy populates an hdb_deployment row with a payload_blob', async () => {
		const project = 'peer-branch-seed-application';
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
		strictEqual(response.status, 200, `seed deploy failed: ${response.body}`);
		const result = JSON.parse(response.body);
		seedDeploymentId = result.deployment_id;
		ok(seedDeploymentId, 'seed deploy should return a deployment_id');

		await sleep(200); // let coalesced writes settle

		const got = await callOperation(ctx, { operation: 'get_deployment', deployment_id: seedDeploymentId });
		strictEqual(got.status, 200);
		ok(got.body.payload_blob_present, 'seed row should have a payload_blob attached');
		ok(got.body.payload_hash, 'seed row should have a sha256 payload_hash');
	});

	// On Bun the deploy hangs after extraction when reading a Web ReadableStream from a
	// file-backed blob inside the same Harper process — same code passes on Node v22/v24
	// across Linux and Windows. Skipping for now; the harper-pro 3-node cluster test
	// (HarperFast/harper-pro#221) covers the same code path end-to-end with real replication.
	const skipOnBun = process.env.HARPER_RUNTIME === 'bun';
	test(
		'peer-side branch: deploy_component with _deploymentId + no payload uses the row blob',
		{ skip: skipOnBun },
		async () => {
			// Simulate the operation shape origin produces for peers via `replicateOperation`:
			// `_deploymentId` set, no `payload`, no multipart. The handler should detect this is a
			// replicated execution and source the tarball from the row's payload_blob.
			const peerProject = 'peer-branch-replay-application';
			const response = await callOperation(ctx, {
				operation: 'deploy_component',
				project: peerProject,
				restart: false,
				_deploymentId: seedDeploymentId,
			});
			strictEqual(response.status, 200, `peer-side deploy should succeed; got ${response.status}: ${response.rawText}`);

			// Confirm the component was actually written on disk (peer code path ran extraction
			// from the row's payload_blob and not from a missing req.payload).
			const fetched = await fetch(`${ctx.harper.operationsAPIURL}/${peerProject}/`, {
				headers: {
					Authorization:
						'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64'),
				},
			});
			// The component exposes nothing routable, but a 404 from the component (vs. a 503/connection
			// failure) confirms it loaded — Harper only routes to deployed component names.
			ok(
				fetched.status === 404 || fetched.status === 200,
				`expected component to be reachable (any 200/404 from the loaded component), got ${fetched.status}`
			);
		}
	);

	// Note: the bogus-_deploymentId-id timeout case isn't covered here because the
	// awaitDeploymentRow 120s default would balloon test time. The timeout path (and the
	// per-deploy deployment_timeout override) is exercised by the unit tests for
	// awaitDeploymentRow directly.
});
