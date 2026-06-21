/**
 * Large-payload streaming deploy_component regression test.
 *
 * Guards against the regression where `ingestPayload` buffered the whole deploy payload
 * in memory and rejected anything over a 200 MB cap (introduced in 5.1.0-beta.1, fixed by
 * making ingestPayload stream the tarball straight into the file-backed payload_blob).
 *
 * The default size (2200 MB of incompressible data) is chosen to clear BOTH ceilings at
 * once: the old 200 MB cap AND Node's ~2 GB single-Buffer limit (0x7fffffff bytes). A
 * buffered implementation fails this test two different ways — a 400 from the cap, or a
 * `Buffer.concat` "Cannot create a Buffer larger than 0x7fffffff bytes" 500. A streaming
 * implementation extracts the component intact with memory bounded by chunk size.
 *
 * Gated behind HARPER_TEST_LARGE_DEPLOY_MB because pushing multi-GB through a deploy is
 * far too heavy for the normal sharded matrix — it runs only on the dedicated self-hosted
 * job (see .github/workflows/large-deploy-test.yml) or when a developer sets the env var
 * locally. Without the env var the suite registers a single skipped test and returns fast.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { randomFillSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from 'node:http';
import { Readable } from 'node:stream';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

// Reach into built dist directly — the integrationTests/ package has no `#src/*` import map.
import { streamPackagedDirectory } from '../../dist/components/packageComponent.js';
import { buildMultipartBody } from '../../dist/bin/multipartBuilder.js';

const LARGE_MB = Number(process.env.HARPER_TEST_LARGE_DEPLOY_MB ?? 0);
const LARGE_BYTES = LARGE_MB * 1024 * 1024;

/**
 * Post a multipart deploy_component request, piping the body stream into node:http so the
 * bytes flow with Transfer-Encoding: chunked (undici would materialize a Readable body into
 * a Buffer, defeating the test). Mirrors deploy-multipart-stream.test.ts.
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

/**
 * Write `bytes` of incompressible pseudo-random data to `path` in bounded-memory chunks, so
 * generating a multi-GB fixture never itself allocates a multi-GB Buffer. Incompressible is
 * essential: the bytes that flow through ingestPayload are the *gzipped* tarball, so a
 * compressible fixture would shrink to nothing and never exercise the large-stream path.
 */
async function writeIncompressibleFile(path: string, bytes: number): Promise<void> {
	const CHUNK = 8 * 1024 * 1024; // 8 MB
	const scratch = Buffer.allocUnsafe(CHUNK);
	const stream = createWriteStream(path);
	let remaining = bytes;
	while (remaining > 0) {
		const n = Math.min(CHUNK, remaining);
		randomFillSync(scratch, 0, n);
		if (!stream.write(n === CHUNK ? scratch : scratch.subarray(0, n))) {
			await once(stream, 'drain');
		}
		remaining -= n;
	}
	stream.end();
	await once(stream, 'finish');
}

suite('Large-payload streaming deploy_component', (ctx: ContextWithHarper) => {
	if (!LARGE_MB) {
		test(
			'skipped (set HARPER_TEST_LARGE_DEPLOY_MB to enable multi-GB deploy regression test)',
			{ skip: true },
			() => {}
		);
		return;
	}

	let fixtureDir: string;

	before(async () => {
		await startHarper(ctx);
		fixtureDir = mkdtempSync(join(tmpdir(), 'large-deploy-fixture-'));
		writeFileSync(join(fixtureDir, 'config.yaml'), 'static:\n  files: web\nrest: true\n');
		mkdirSync(join(fixtureDir, 'web'), { recursive: true });
		writeFileSync(join(fixtureDir, 'web', 'index.html'), '<h1>Hello, Large!</h1>');
		await writeIncompressibleFile(join(fixtureDir, 'web', 'large.bin'), LARGE_BYTES);
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

	test(
		`deploys a ${LARGE_MB} MB streamed payload without buffering it whole`,
		{ timeout: 30 * 60 * 1000 },
		async () => {
			const project = 'large-payload-application';
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

			// Wait for the restart + extraction of a multi-GB component to settle.
			await sleep(15000);
			const extracted = join(ctx.harper.dataRootDir, 'components', project, 'web', 'large.bin');
			ok(existsSync(extracted), 'large file part should have been extracted');
			strictEqual(
				statSync(extracted).size,
				LARGE_BYTES,
				'extracted large file should be byte-for-byte the same size as the source'
			);
		}
	);
});
