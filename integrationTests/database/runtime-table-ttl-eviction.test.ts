/**
 * A table created at runtime through the operations API, with a table-level `expiration`, is evicted by
 * the cleanup scan with no query or GET touching its rows. The thread serving the operation creates the
 * table and every worker loads it from the catalog; the scan runs on the store-maintenance owner (the last
 * worker), so this runs four workers, on both storage engines.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const DATABASE = 'runtime_ttl';
const TABLE = 'expiring';
const RECORD_COUNT = 10;

async function operation(ctx: ContextWithHarper, body: Record<string, unknown>) {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`,
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	strictEqual(response.status, 200, `${body.operation} failed: ${text}`);
	return JSON.parse(text);
}

for (const engine of ['rocksdb', 'lmdb']) {
	suite(`Runtime-created TTL table eviction (${engine})`, (ctx: ContextWithHarper) => {
		before(async () => {
			await startHarper(ctx, {
				config: { threads: { count: 4 } },
				env: engine === 'lmdb' ? { HARPER_STORAGE_ENGINE: 'lmdb' } : {},
			});
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('expired records are evicted without being read', { timeout: 60_000 }, async () => {
			strictEqual((await operation(ctx, { operation: 'get_configuration' })).threads.count, 4);
			await operation(ctx, { operation: 'create_database', database: DATABASE });
			const storage = statSync(
				join(ctx.harper.dataRootDir, 'database', engine === 'lmdb' ? `${DATABASE}.mdb` : DATABASE)
			);
			ok(engine === 'lmdb' ? storage.isFile() : storage.isDirectory(), `the database is not stored by ${engine}`);
			await operation(ctx, {
				operation: 'create_table',
				database: DATABASE,
				table: TABLE,
				primary_key: 'id',
				expiration: 3,
			});
			const records = Array.from({ length: RECORD_COUNT }, (_, i) => ({ id: i, value: `v${i}` }));
			await operation(ctx, { operation: 'insert', database: DATABASE, table: TABLE, records });

			// describe_table counts stored entries without going through a query or GET
			const recordCount = async () =>
				(await operation(ctx, { operation: 'describe_table', database: DATABASE, table: TABLE })).record_count;
			strictEqual(await recordCount(), RECORD_COUNT);
			let count: number;
			const deadline = Date.now() + 30_000;
			do {
				await sleep(500);
				count = await recordCount();
			} while (count > 0 && Date.now() < deadline);
			strictEqual(count, 0, `${count} of ${RECORD_COUNT} expired records are still stored 30s after insert`);
		});
	});
}
