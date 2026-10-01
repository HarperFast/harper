import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import http from 'node:http';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { unpack } from 'msgpackr';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'response-compression');
const THRESHOLD = 1200;

interface Captured {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: Buffer;
	error?: Error;
}

function request(url: string, headers: Record<string, string>): Promise<Captured> {
	return new Promise((resolvePromise, reject) => {
		const req = http.get(url, { headers }, (res) => {
			const chunks: Buffer[] = [];
			const done = (error?: Error) =>
				resolvePromise({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks), error });
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => done());
			res.on('aborted', () => done(new Error('aborted')));
			res.on('error', (error) => done(error));
		});
		req.on('error', reject);
	});
}

const decoded = (captured: Captured) =>
	captured.headers['content-encoding'] === 'br' ? brotliDecompressSync(captured.body) : captured.body;

const records = (count: number) => Array.from({ length: count }, (_, n) => ({ n, label: `record number ${n}` }));

suite('response compression', { skip: process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let restBase = '';
	let authorization = '';
	const get = (path: string, accept: string, acceptEncoding = 'br') =>
		request(`${restBase}${path}`, {
			'Authorization': authorization,
			'Accept': accept,
			'Accept-Encoding': acceptEncoding,
		});

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 1 }, http: { compressionThreshold: THRESHOLD } },
			env: {},
		});
		const client = createApiClient(ctx.harper);
		restBase = client.restURL;
		authorization = client.headers.Authorization as string;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const health = await get('/Health/', 'application/json').catch(() => null);
			if (health?.status === 200) return;
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`fixture never became ready at ${restBase}/Health/`);
	});

	after(() => teardownHarper(ctx));

	test('a JSON object above the threshold is brotli-encoded and round-trips', async () => {
		const response = await get('/BigObject/', 'application/json');
		strictEqual(response.status, 200);
		strictEqual(response.headers['content-encoding'], 'br');
		deepStrictEqual(JSON.parse(decoded(response).toString()), { records: records(200) });
		ok(response.body.length < decoded(response).length / 3, 'compressed body should be much smaller');
		if (process.env.HARPER_RUNTIME !== 'bun') {
			const expected = brotliCompressSync(decoded(response), {
				params: { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_QUALITY]: 2 },
			});
			ok(response.body.equals(expected), 'buffer responses must be encoded at quality 2');
		}
	});

	test('the same response is uncompressed for a client that does not accept br', async () => {
		const response = await get('/BigObject/', 'application/json', 'gzip');
		strictEqual(response.headers['content-encoding'], undefined);
		deepStrictEqual(JSON.parse(response.body.toString()), { records: records(200) });
	});

	test('a msgpack array above the threshold is brotli-encoded and round-trips', async () => {
		const response = await get('/BigArray/', 'application/x-msgpack');
		strictEqual(response.status, 200);
		strictEqual(response.headers['content-encoding'], 'br');
		deepStrictEqual(unpack(decoded(response)), records(200));
	});

	test('a msgpack array below the threshold is sent uncompressed', async () => {
		const response = await get('/SmallArray/', 'application/x-msgpack');
		strictEqual(response.status, 200);
		strictEqual(response.headers['content-encoding'], undefined);
		deepStrictEqual(unpack(response.body), [1, 2, 3]);
	});

	test('a streamed JSON array is brotli-encoded and round-trips', async () => {
		const response = await get('/StreamedArray/', 'application/json');
		strictEqual(response.status, 200);
		strictEqual(response.headers['content-encoding'], 'br');
		deepStrictEqual(JSON.parse(decoded(response).toString()), records(200));
	});

	for (const type of ['application/x-compression-iterator', 'application/x-compression-async-iterator']) {
		test(`a custom handler returning a generator (${type}) is brotli-encoded`, async () => {
			const response = await get('/StreamedArray/', type);
			strictEqual(response.status, 200);
			strictEqual(response.headers['content-encoding'], 'br');
			strictEqual(decoded(response).toString(), 'onetwo');
		});
	}

	test(
		'a source stream failing mid-response terminates it and the worker keeps serving',
		{ timeout: 20_000 },
		async () => {
			// brotli holds the first chunk, so the failure can land before or after the headers are sent
			const outcome = await get('/StreamedArray/', 'application/x-compression-failing-stream').then(
				(response) => response.error,
				(error) => error
			);
			ok(outcome instanceof Error, 'a failed source must end the response abruptly, not as a complete body');
			const health = await get('/Health/', 'application/json');
			strictEqual(health.status, 200);
			deepStrictEqual(JSON.parse(health.body.toString()), { ok: true });
		}
	);
});
