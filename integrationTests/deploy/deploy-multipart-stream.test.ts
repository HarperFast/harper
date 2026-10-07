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
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { join } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
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

function firstResponseBody(response: string): string {
	const headEnd = response.indexOf('\r\n\r\n');
	const head = response.slice(0, headEnd).toLowerCase();
	let rest = response.slice(headEnd + 4);
	if (!head.includes('transfer-encoding: chunked')) {
		const length = Number(/content-length: (\d+)/.exec(head)?.[1] ?? rest.length);
		return rest.slice(0, length);
	}
	let body = '';
	for (;;) {
		const lineEnd = rest.indexOf('\r\n');
		const size = parseInt(rest.slice(0, lineEnd), 16);
		if (!size) return body;
		body += rest.slice(lineEnd + 2, lineEnd + 2 + size);
		rest = rest.slice(lineEnd + 2 + size + 2);
	}
}

function sseErrors(body: string): Array<{ message?: string; code?: number }> {
	return body
		.split('\n\n')
		.filter((block) => block.split('\n').includes('event: error'))
		.map((block) =>
			JSON.parse(
				block
					.split('\n')
					.filter((line) => line.startsWith('data: '))
					.map((line) => line.slice(6))
					.join('\n')
			)
		);
}

interface RawUpload {
	response: string;
	statuses: string[];
}

// Node's own client stops writing after an early complete answer, so this uses a raw socket. It sends the rest of
// the upload only once `answered` holds, then a second request: a server that answers only after the whole upload,
// or stops reading once it has answered, never finishes both.
function uploadOnRawSocket(
	ctx: ContextWithHarper,
	fields: Record<string, unknown>,
	answered: (response: string) => boolean,
	{ sse = false, fileBytes = 16 * 1024 * 1024, deadlineMs = 30_000 } = {}
): Promise<RawUpload> {
	const url = new URL(ctx.harper.operationsAPIURL);
	const chunk = randomBytes(64 * 1024);
	async function* fileChunks() {
		for (let sent = 0; sent < fileBytes; sent += chunk.length) yield chunk;
	}
	const multipart = buildMultipartBody(fields, {
		name: 'payload',
		filename: 'package.tar.gz',
		contentType: 'application/gzip',
		stream: Readable.from(fileChunks()),
	});
	const auth = Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
	return new Promise((resolve, reject) => {
		const socket = connect(Number(url.port), url.hostname);
		let response = '';
		let stage = 'sending the first megabyte';
		let settled = false;
		let onAnswer!: () => void;
		const answer = new Promise<void>((resolveAnswer) => (onAnswer = () => resolveAnswer()));
		const statuses = () => response.match(/HTTP\/1\.1 \d{3}/g) ?? [];
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			socket.destroy();
			if (error) reject(error);
			else resolve({ response, statuses: statuses() });
		};
		const unfinished = (why: string) => new Error(`${why} while ${stage}; received: ${response.slice(0, 300)}`);
		const deadline = setTimeout(() => finish(unfinished(`unfinished after ${deadlineMs}ms`)), deadlineMs);
		socket.on('error', finish);
		socket.on('close', () => finish(unfinished('the connection closed')));
		socket.on('data', (data) => {
			response += data;
			if (answered(response)) onAnswer();
			if (stage === 'waiting for the second answer' && statuses().length >= 2) finish();
		});
		socket.once('connect', async () => {
			try {
				socket.write(
					`POST / HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Basic ${auth}\r\nContent-Type: ${multipart.contentType}\r\n` +
						(sse ? 'Accept: text/event-stream\r\n' : '') +
						'Transfer-Encoding: chunked\r\n\r\n'
				);
				let sent = 0;
				for await (const part of multipart.stream) {
					if (socket.destroyed) return;
					if (stage === 'sending the first megabyte' && sent >= 1024 * 1024) {
						stage = 'waiting for the answer';
						await answer;
						stage = 'sending the rest of the upload';
					}
					const frame = Buffer.concat([Buffer.from(`${part.length.toString(16)}\r\n`), part, Buffer.from('\r\n')]);
					if (!socket.write(frame)) await new Promise((resume) => socket.once('drain', resume));
					sent += part.length;
				}
				if (socket.destroyed) return;
				socket.write('0\r\n\r\n', (error) => {
					if (error || socket.destroyed) return;
					stage = 'waiting for the second answer';
					socket.write(`GET /health HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`);
				});
			} catch (error) {
				finish(error as Error);
			}
		});
	});
}

suite('Multipart streaming deploy_component', (ctx: ContextWithHarper) => {
	let fixtureDir: string;
	let blob: Buffer;

	before(async () => {
		await startHarper(ctx);
		// Build a temporary fixture: the same shape as integrationTests/deploy/fixture,
		// plus a multi-MB blob to exercise the streaming path with real chunk boundaries.
		// 4 MB keeps CI fast while still being well past the buffer→stream switchover that
		// busboy's parser handles internally (default 64 KB chunks).
		fixtureDir = mkdtempSync(join(tmpdir(), 'mp-deploy-fixture-'));
		// Match the existing deploy-from-source fixture's shape so the static-content
		// reachability assertion below mirrors deploy-from-source's `access deployed
		// application` test (just s/Hello, Harper/Hello, Multipart/ on the file body).
		writeFileSync(
			join(fixtureDir, 'config.yaml'),
			'static:\n  files: web\ngraphqlSchema:\n  files: schema.graphql\nrest: true\n'
		);
		writeFileSync(join(fixtureDir, 'schema.graphql'), 'type Query { hello: String }\n');
		mkdirSync(join(fixtureDir, 'web'), { recursive: true });
		writeFileSync(join(fixtureDir, 'web', 'index.html'), '<h1>Hello, Multipart!</h1>');
		// 4 MB of random data — incompressible, so the gzipped payload stays as large as the
		// file, and the multipart parser sees many busboy chunks before the file part ends.
		blob = randomBytes(4 * 1024 * 1024);
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
			readFileSync(join(ctx.harper.dataRootDir, 'components', project, 'web', 'blob.bin')).equals(blob),
			'the large file part was extracted byte for byte'
		);
	});

	test('deployed multipart-streamed application is reachable', async () => {
		const response = await fetch(ctx.harper.httpURL);
		strictEqual(response.status, 200);
		ok((await response.text()).includes('<h1>Hello, Multipart!</h1>'));
	});

	// Under Bun, Harper reads the whole body before Fastify sees the request, so no upload can stall behind an unread part.
	const skip = process.env.HARPER_RUNTIME === 'bun' && 'the body is buffered before Fastify under Bun';
	const refusals: Array<[string, Record<string, unknown>, boolean, string, string]> = [
		[
			'a payload deploy it refuses',
			{ operation: 'deploy_component', project: 'refused-multipart', isolated: true },
			false,
			'HTTP/1.1 400',
			"'isolated' is only supported for package deployments",
		],
		[
			'a payload deploy it refuses in its event stream',
			{ operation: 'deploy_component', project: 'refused-multipart-sse', isolated: true },
			true,
			'HTTP/1.1 200',
			"'isolated' is only supported for package deployments",
		],
		[
			'a request with no operation',
			{ project: 'no-operation' },
			false,
			'HTTP/1.1 400',
			"Request body must include an 'operation' property",
		],
	];
	for (const [description, fields, sse, status, message] of refusals) {
		test(
			`reads the rest of the upload of ${description}, then serves the next request on that connection`,
			{ skip },
			async () => {
				const upload = await uploadOnRawSocket(ctx, fields, (response) => response.includes(message), { sse });
				const body = firstResponseBody(upload.response);
				if (sse) {
					const [error] = sseErrors(body);
					ok(error?.message?.includes(message), body);
					strictEqual(error.code, 400);
				} else {
					ok(JSON.parse(body).error.includes(message), body);
				}
				deepStrictEqual(upload.statuses, [status, 'HTTP/1.1 200']);
			}
		);
	}
});
