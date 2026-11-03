import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import http from 'node:http';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { unpack, unpackMultiple } from 'msgpackr';
import { decode as decodeCbor } from 'cbor-x';
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

function request(url: string, headers: Record<string, string>, method = 'GET'): Promise<Captured> {
	return new Promise((resolvePromise, reject) => {
		const req = http.request(url, { headers, method }, (res) => {
			const chunks: Buffer[] = [];
			const done = (error?: Error) =>
				resolvePromise({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks), error });
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => done());
			res.on('aborted', () => done(new Error('aborted')));
			res.on('error', (error) => done(error));
		});
		req.on('error', reject);
		req.end();
	});
}

const decoded = (captured: Captured) =>
	captured.headers['content-encoding'] === 'br' ? brotliDecompressSync(captured.body) : captured.body;

const records = (count: number) => Array.from({ length: count }, (_, n) => ({ n, label: `record number ${n}` }));

suite('response compression', { skip: process.platform === 'win32' }, (ctx: ContextWithHarper) => {
	let restBase = '';
	let authorization = '';
	const get = (path: string, accept: string, acceptEncoding = 'br', method = 'GET') =>
		request(
			`${restBase}${path}`,
			{
				'Authorization': authorization,
				'Accept': accept,
				'Accept-Encoding': acceptEncoding,
			},
			method
		);
	const rowCounts = async () => JSON.parse((await get('/RowCounts/', 'application/json', 'identity')).body.toString());
	const settledRowCounts = async () => {
		const counts = { opened: 0, stepped: 0, returned: 0 };
		const deadline = Date.now() + 5_000;
		do {
			await new Promise((r) => setTimeout(r, 50));
			const next = await rowCounts();
			counts.opened += next.opened;
			counts.stepped += next.stepped;
			counts.returned += next.returned;
		} while (counts.returned < counts.opened && Date.now() < deadline);
		return counts;
	};
	const streamedRows: Record<string, (body: Buffer) => unknown[]> = {
		'application/cbor': (body) => decodeCbor(body),
		'application/x-msgpack': (body) => unpackMultiple(body),
		'text/csv': (body) => body.toString().trim().split('\n').slice(1),
	};

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

	for (const [accept, parse] of Object.entries(streamedRows)) {
		test(`a compressed ${accept} stream round-trips, and its HEAD leaves the source unread`, async () => {
			await rowCounts();
			const response = await get('/CountedRows/', accept);
			strictEqual(response.status, 200);
			strictEqual(response.headers['content-encoding'], 'br');
			strictEqual(parse(decoded(response)).length, 200);
			const { opened, stepped } = await rowCounts();
			deepStrictEqual({ opened, stepped }, { opened: 1, stepped: 200 });

			const head = await get('/CountedRows/', accept, 'br', 'HEAD');
			strictEqual(head.status, 200);
			// the only open is the discard's own close of a fresh iterator
			deepStrictEqual(await settledRowCounts(), { opened: 1, stepped: 0, returned: 1 });
		});

		test(`a client disconnecting from a ${accept} stream closes its source`, { timeout: 20_000 }, async () => {
			await rowCounts();
			await new Promise<void>((resolvePromise, reject) => {
				const req = http.get(
					`${restBase}/SlowCountedRows/`,
					{ headers: { 'Authorization': authorization, 'Accept': accept, 'Accept-Encoding': 'identity' } },
					(res) => {
						res.once('data', () => {
							req.destroy();
							resolvePromise();
						});
					}
				);
				req.on('error', () => {});
				setTimeout(() => reject(new Error('no data before the deadline')), 10_000);
			});
			const counts = await settledRowCounts();
			strictEqual(counts.opened, 1);
			strictEqual(counts.returned, 1);
			ok(counts.stepped < 200, 'the source must stop being read after the disconnect');
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
