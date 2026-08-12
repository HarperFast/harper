/**
 * Deployment tracking — peer-operation authorization boundary.
 *
 * In a real multi-node deploy, the origin sends a private `component_deploy_phase`
 * operation and the peer reads the tarball from the replicated
 * `hdb_deployment.payload_blob` row. The authorization-bypass context that admits that
 * operation exists only around trusted replication dispatch, so an HTTP caller must not
 * be able to impersonate a peer with the legacy `_deploymentId` marker. This test:
 *
 *   1. Doing a normal deploy to populate an `hdb_deployment` row with a `payload_blob`.
 *   2. Submitting a second public `deploy_component` operation with `_deploymentId` set.
 *   3. Asserting validation rejects the caller-controlled internal marker.
 *
 * The true 3-node test (including the trusted peer operation, BLOB_CHUNK delivery, and
 * `peer_results`) lives in harper-pro, where `replicateOperation` is implemented.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomFillSync } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from 'node:http';
import { Readable } from 'node:stream';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

import { streamPackagedDirectory } from '../../dist/components/packageComponent.js';
import { buildMultipartBody } from '../../dist/bin/multipartBuilder.js';

const PEER_PROJECT = 'peer-branch-replay-application';

function filesUnder(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = join(directory, entry.name);
		return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
	});
}

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

suite('Deployment tracking — peer-operation authorization boundary', (ctx: ContextWithHarper) => {
	let fixtureDir: string;
	let seedDeploymentId: string;

	before(async () => {
		await startHarper(ctx, { config: { storage: { blobReadTimeout: 2000 } }, env: {} });
		fixtureDir = mkdtempSync(join(tmpdir(), 'peer-branch-fixture-'));
		writeFileSync(join(fixtureDir, 'config.yaml'), 'graphqlSchema:\n  files: schema.graphql\nrest: true\n');
		writeFileSync(join(fixtureDir, 'schema.graphql'), 'type Query { hello: String }\n');
		mkdirSync(join(fixtureDir, 'web'), { recursive: true });
		writeFileSync(join(fixtureDir, 'web', 'index.html'), '<h1>Hello, Peer Branch!</h1>');
		writeFileSync(join(fixtureDir, 'web', 'blob.bin'), randomFillSync(Buffer.alloc(2 * 1024 * 1024)));
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
		const existingBlobFiles = new Set(filesUnder(join(ctx.harper.dataRootDir, 'blobs', 'system')));
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
		const blobFiles = filesUnder(join(ctx.harper.dataRootDir, 'blobs', 'system'))
			.filter((path) => !existingBlobFiles.has(path))
			.map((path) => ({ path, size: statSync(path).size }))
			.sort((left, right) => right.size - left.size);
		const [payloadBlobFile] = blobFiles;
		ok(payloadBlobFile?.size > 1024 * 1024, 'expected the retained deployment payload to be file-backed');
	});

	test('public deploy_component rejects the legacy _deploymentId peer marker', async () => {
		const response = await callOperation(ctx, {
			operation: 'deploy_component',
			project: PEER_PROJECT,
			restart: false,
			_deploymentId: seedDeploymentId,
		});
		strictEqual(response.status, 400, `internal marker should be rejected; got: ${response.rawText}`);
		strictEqual(response.body.error, "'_deploymentId' is not allowed");
	});
	// #2066's two peer-branch end-to-end tests used to drive the peer path by sending `_deploymentId`
	// on a PUBLIC deploy_component call. That back door is deliberately closed (see the test above):
	// peer work now rides the trusted-peer-only `component_deploy_phase` operation, which by design
	// cannot be reached over HTTP with ordinary credentials — so those two tests have no legitimate
	// entry point here any more. Their coverage lives on:
	//   - restore-on-failure: unitTests/components/extractApplicationSwap.test.js ("restores the exact
	//     previous tree when payload extraction fails", "atomically restores the previous tree when
	//     preparation fails under a live writer", "recovers an interrupted deploy before component
	//     loading").
	//   - sourcing the tarball from the row's payload_blob on a peer: the trusted-peer phase tests in
	//     unitTests/components/deployPhaseOperations.test.js ("uses the row-backed immutable
	//     specification for trusted peer phases", "rebuilds a missing peer stage from the durable
	//     deployment payload before activation"), which dispatch the internal operation inside
	//     runWithOperationAuthorizationBypass.
	// The bogus-_deploymentId timeout case is likewise covered by the awaitDeploymentRow unit tests
	// rather than here, where the 120s default would balloon test time.
});
