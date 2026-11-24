import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'sourcedfrom-schema-validation');

suite('sourcedFrom fills that do not match the schema, over REST', (ctx: ContextWithHarper) => {
	const originRecords = new Map<string, object>();
	const originRequests = new Map<string, number>();
	let origin: http.Server;
	let restURL: string;
	let headers: Record<string, string>;

	before(async () => {
		origin = http.createServer((req, res) => {
			const id = decodeURIComponent(/^\/item\/(.+)$/.exec(req.url ?? '')?.[1] ?? '');
			originRequests.set(id, (originRequests.get(id) ?? 0) + 1);
			res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(originRecords.get(id)));
		});
		await new Promise<void>((listening) => origin.listen(0, '127.0.0.1', listening));
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			env: { VALIDATION_ORIGIN_PORT: String((origin.address() as AddressInfo).port) },
		});
		const client = createApiClient(ctx.harper);
		restURL = client.restURL.replace(/\/$/, '');
		headers = client.headers;
	});

	after(async () => {
		try {
			await teardownHarper(ctx);
		} finally {
			if (origin) await new Promise((closed) => origin.close(closed));
		}
	});

	const request = async (method: string, id: string, body?: object) => {
		const response = await fetch(`${restURL}/ValidatedCache/${id}`, {
			method,
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: body && JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		return { status: response.status, body: await response.text() };
	};

	test('a record that does not match the schema is served and cached as the source returned it', async () => {
		const malformed = { id: 'item', count: 'not-a-number' };
		strictEqual((await request('PUT', 'malformed-put', { ...malformed, id: 'malformed-put' })).status, 400);

		originRecords.set('item', malformed);
		const filled = await request('GET', 'item');
		strictEqual(filled.status, 200, filled.body);
		deepStrictEqual(JSON.parse(filled.body), malformed);
		const cached = await request('GET', 'item');
		strictEqual(cached.status, 200, cached.body);
		deepStrictEqual(JSON.parse(cached.body), malformed);
		strictEqual(originRequests.get('item'), 1, 'the record was not served from the cache');
	});
});
