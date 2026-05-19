/**
 * Multipart-streaming deploy_component integration test.
 *
 * Exercises the end-to-end path introduced by #530: a CLI-side multipart/form-data body
 * with the package payload streamed as the file part, parsed on the server, and piped
 * straight into extraction. This is the path that lifts the 2 GB Buffer ceiling for
 * `payload`-based deploys.
 *
 * The fixture used here is identical to deploy-from-source's fixture but the wire
 * format is multipart instead of base64-encoded-in-JSON, so this is an explicit
 * regression test for the new code path's plumbing rather than payload size — pushing
 * a multi-GB body through CI would be impractical.
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

// The integrationTests/ package doesn't have the `#src/*` import map, so we reach into
// the built dist directly. This mirrors how other integration tests pull in code under
// test from `../../dist/...` when they need to.
import { streamPackagedDirectory } from '../../dist/components/packageComponent.js';
import { buildMultipartBody } from '../../dist/bin/multipartBuilder.js';

/**
 * Post a multipart deploy_component request to the operations API by piping the body
 * stream into a Node http.request. We don't use `fetch` here because Undici's body
 * coercion materializes Readable bodies into a Buffer for HTTP/1, which would defeat
 * the whole point — we want bytes flowing through node:http with Transfer-Encoding:
 * chunked the same way the CLI does it.
 */
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

suite('Multipart streaming deploy_component', (ctx: ContextWithHarper) => {
	let fixtureDir: string;

	before(async () => {
		await startHarper(ctx);
		// Build a temporary fixture: the same shape as integrationTests/deploy/fixture,
		// plus a multi-MB blob to exercise the streaming path with real chunk boundaries.
		// 4 MB keeps CI fast while still being well past the buffer→stream switchover that
		// busboy's parser handles internally (default 64 KB chunks).
		fixtureDir = mkdtempSync(join(tmpdir(), 'mp-deploy-fixture-'));
		writeFileSync(join(fixtureDir, 'config.yaml'), 'rest: true\ngraphqlSchema:\n  files: schema.graphql\n');
		writeFileSync(join(fixtureDir, 'schema.graphql'), 'type Query { hello: String }\n');
		mkdirSync(join(fixtureDir, 'web'), { recursive: true });
		writeFileSync(join(fixtureDir, 'web', 'index.html'), '<h1>Hello, Multipart!</h1>');
		// 4 MB of pseudo-random data — non-compressible enough that gzip can't trivialize it,
		// large enough that the multipart parser definitely sees several busboy chunks
		// before the file part ends.
		const blob = Buffer.alloc(4 * 1024 * 1024);
		for (let i = 0; i < blob.length; i++) blob[i] = (i * 1103515245 + 12345) & 0xff;
		writeFileSync(join(fixtureDir, 'web', 'blob.bin'), blob);
	});

	after(async () => {
		try {
			rmSync(fixtureDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		await teardownHarper(ctx);
	});

	test('verify Harper', async () => {
		const response = await fetch(`${ctx.harper.operationsAPIURL}/health`);
		strictEqual(response.status, 200);
		strictEqual(await response.text(), 'Harper is running.');
	});

	test('deploys via multipart/form-data with streamed payload', async () => {
		const project = 'multipart-test-application';
		const multipart = buildMultipartBody(
			{ operation: 'deploy_component', project, restart: true },
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
		strictEqual(result.message, `Successfully deployed: ${project}, restarting Harper`);
		await sleep(5000);
		ok(existsSync(join(ctx.harper.dataRootDir, 'components', project)));
		ok(
			existsSync(join(ctx.harper.dataRootDir, 'components', project, 'web', 'blob.bin')),
			'large file part should have been extracted intact'
		);
	});

	test('deployed multipart-streamed application is reachable', async () => {
		const response = await fetch(ctx.harper.httpURL);
		strictEqual(response.status, 200);
		ok((await response.text()).includes('<h1>Hello, Multipart!</h1>'));
	});
});
