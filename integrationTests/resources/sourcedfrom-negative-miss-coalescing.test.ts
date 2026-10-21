/**
 * Concurrent REST reads of one key on a sourcedFrom table make one origin request, including when
 * the origin reports the record missing and when the client sends `Cache-Control: no-store`.
 * One worker thread: requests on different threads coalesce only through the record lock and still
 * re-fetch in turn, which this test does not cover.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sourcedfrom-negative-miss-coalescing');
const CONCURRENCY = 20;

suite('sourcedFrom concurrent misses over REST', (ctx: ContextWithHarper) => {
	const originRecords = new Map([['present', { id: 'present', name: 'from origin' }]]);
	const originRequests = new Map<string, number>();
	let origin: http.Server;
	let restURL: string;
	let headers: Record<string, string>;

	before(async () => {
		origin = http.createServer(async (req, res) => {
			const id = decodeURIComponent(/^\/item\/(.+)$/.exec(req.url ?? '')?.[1] ?? '');
			originRequests.set(id, (originRequests.get(id) ?? 0) + 1);
			await sleep(300);
			const record = originRecords.get(id);
			if (record) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(record));
			else res.writeHead(404).end();
		});
		await new Promise<void>((listening) => origin.listen(0, '127.0.0.1', listening));
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 1 } },
			env: { COALESCING_ORIGIN_PORT: String((origin.address() as AddressInfo).port) },
		});
		const client = createApiClient(ctx.harper);
		restURL = client.restURL.replace(/\/$/, '');
		headers = client.headers;
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			await new Promise((closed) => origin.close(closed));
		}
	});

	const concurrentGets = (id: string, extraHeaders: Record<string, string> = {}) =>
		Promise.all(
			Array.from({ length: CONCURRENCY }, async () => {
				const response = await fetch(`${restURL}/CoalescedCache/${id}`, {
					headers: { ...headers, ...extraHeaders },
					signal: AbortSignal.timeout(30_000),
				});
				const body = await response.text();
				return response.status === 200 ? JSON.parse(body).name : response.status;
			})
		);

	test('a record the origin reports missing', async () => {
		deepStrictEqual(await concurrentGets('absent'), Array(CONCURRENCY).fill(404));
		strictEqual(originRequests.get('absent'), 1);
	});

	test('a record read with Cache-Control: no-store', async () => {
		deepStrictEqual(
			await concurrentGets('present', { 'Cache-Control': 'no-store' }),
			Array(CONCURRENCY).fill('from origin')
		);
		strictEqual(originRequests.get('present'), 1);
	});
});
