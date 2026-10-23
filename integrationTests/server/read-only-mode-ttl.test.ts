/**
 * A read-only server (`storage.readOnly`) answers for an expired record on a table with no source as if it were
 * absent, and leaves it on disk (harper#474). Runs on whichever engine HARPER_STORAGE_ENGINE selects.
 *
 *   npm run test:integration -- "integrationTests/server/read-only-mode-ttl.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import request from 'supertest';

import {
	setupHarperWithFixture,
	killHarper,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'read-only-mode-ttl');
// The writable server's expiresAt sweep removes a row as soon as it expires, so the seed expires after the restart.
const SEED_EXPIRES_IN_MS = 5_000;
// Read-only startup fails on Windows (#2853)
const skipSuite = process.platform === 'win32';

suite('read-only mode leaves an expired record alone', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
		client = createApiClient(ctx.harper);
		const now = Date.now();
		for (const [table, id, expiresAt] of [
			['Session', 'expired', now + SEED_EXPIRES_IN_MS],
			['Session', 'live', now + 3_600_000],
			['Plain', 'live', undefined],
		] as const) {
			await request(ctx.harper.httpURL)
				.put(`/${table}/${id}`)
				.set(client.headers)
				.send({ id, name: 'ttl', expiresAt })
				.expect((r: any) => ok(r.status < 300, `seeding failed: ${r.status} ${r.text}`));
		}
		await killHarper(ctx);
		await startHarper(ctx, { config: { storage: { readOnly: true } }, env: {} });
		client = createApiClient(ctx.harper);
		await delay(Math.max(0, now + SEED_EXPIRES_IN_MS - Date.now() + 100));
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function rawEntry(table: string, id: string) {
		return (await client.reqRest(`/RawEntry/?table=${table}&id=${id}`).expect(200)).body;
	}

	test('the expired record is on disk and past its expiry when the server starts read-only', async () => {
		const entry = await rawEntry('Session', 'expired');
		ok(entry.hasValue, JSON.stringify(entry));
		ok(entry.expiresAt < Date.now(), JSON.stringify(entry));
	});

	test('a GET by id answers 404, not a server error', async () => {
		for (let i = 0; i < 3; i++) await client.reqRest('/Session/expired').expect(404);
	});

	test('a query by an indexed attribute omits it', async () => {
		const response = await client.reqRest('/Session/?name=ttl&select(id)').expect(200);
		deepStrictEqual(response.body, ['live']);
	});

	test('a query with no index to use omits it', async () => {
		const response = await client.reqRest('/Session/?id=ne=nothing&select(id)').expect(200);
		deepStrictEqual(response.body, ['live']);
	});

	test('a live record on the same table is still served', async () => {
		strictEqual((await client.reqRest('/Session/live').expect(200)).body.name, 'ttl');
	});

	test('reads of a table without a TTL still work', async () => {
		strictEqual((await client.reqRest('/Plain/live').expect(200)).body.name, 'ttl');
	});

	test('the record is still on disk after the reads', async () => {
		const entry = await rawEntry('Session', 'expired');
		ok(entry.hasValue, JSON.stringify(entry));
	});

	test('a writable server removes it on the first read, as before', async () => {
		await killHarper(ctx);
		await startHarper(ctx, { env: {} });
		client = createApiClient(ctx.harper);
		ok((await rawEntry('Session', 'expired')).hasValue, 'the read-only server left the record on disk');
		await client.reqRest('/Session/expired').expect(404);
		const deadline = Date.now() + 10_000;
		while ((await rawEntry('Session', 'expired')).hasValue) {
			ok(Date.now() < deadline, 'the writable server never evicted the expired record');
			await delay(100);
		}
	});
});
