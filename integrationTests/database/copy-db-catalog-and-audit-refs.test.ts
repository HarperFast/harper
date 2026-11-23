/**
 * LMDB seed, then compactOnStart, then migrateOnStart, reading everything back after each boot.
 *
 *   npm run test:integration -- "integrationTests/database/copy-db-catalog-and-audit-refs.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'copy-db-catalog-and-audit-refs');
const RECORD_COUNT = 12;
const RESIDENCY_OWNERS = ['node-a', 'node-b'];
const RESIDENCY_ID = 70000;
const NEXT_TABLE_ID = 50;
const BOOT_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 60_000;

interface Verification {
	engine: string;
	records: Record<string, { n: number; label: string; group: string }>;
	undecodable: unknown[];
	auditRefFlagged: number;
	indexHits: number;
	residency: string[] | null;
	residencyBySet: number | null;
	nextTableId: number | null;
}

const expectedRecords = () =>
	Object.fromEntries(
		Array.from({ length: RECORD_COUNT }, (_, index) => [
			`c${index}`,
			// labels of varied length, so a body misread as a ref count lands on different bytes
			{ n: index + 1, label: 'x'.repeat(index * 5 + 1), group: 'g' },
		])
	);

suite('compaction and migration keep audit refs and catalog rows', (ctx: ContextWithHarper) => {
	let auth = '';

	const call = async (method: string, path: string, body?: unknown) => {
		const response = await fetch(`${ctx.harper.httpURL}${path}`, {
			method,
			headers: { Authorization: auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await response.text();
		ok(response.status < 300, `${method} ${path} => ${response.status}: ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : undefined;
	};

	async function verify(label: string): Promise<Verification> {
		auth = 'Basic ' + Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64');
		const deadline = Date.now() + READY_TIMEOUT_MS;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				return await call('GET', '/Verify/');
			} catch (error) {
				lastError = error;
				await new Promise((resolveWait) => setTimeout(resolveWait, 250));
			}
		}
		throw new Error(`/Verify/ did not answer ${label}: ${lastError}`);
	}

	function assertComplete(result: Verification, label: string) {
		deepStrictEqual(result.undecodable, [], `records that no longer decode ${label}`);
		strictEqual(result.auditRefFlagged, RECORD_COUNT, `records with header audit refs ${label}`);
		deepStrictEqual(result.records, expectedRecords(), `record bodies ${label}`);
		strictEqual(result.indexHits, RECORD_COUNT, `secondary index hits ${label}`);
		deepStrictEqual(result.residency, RESIDENCY_OWNERS, `residency_by_id ${label}`);
		strictEqual(result.residencyBySet, RESIDENCY_ID, `residency_by_set ${label}`);
		strictEqual(result.nextTableId, NEXT_TABLE_ID, `next-table-id ${label}`);
	}

	before(
		async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: 1 } },
				env: { HARPER_STORAGE_ENGINE: 'lmdb' },
			});
			await verify('on first boot');
			for (let index = 0; index < RECORD_COUNT; index++) {
				const id = `c${index}`;
				await call('PUT', `/Counter/${id}`, { id, group: 'g', label: 'x'.repeat(index * 5 + 1), n: 0 });
				for (let patch = 0; patch <= index; patch++)
					await call('PATCH', `/Counter/${id}`, { n: { __op__: 'add', value: 1 } });
			}
			await call('POST', '/SeedCatalog/', {});
		},
		{ timeout: BOOT_TIMEOUT_MS + 120_000 }
	);

	after(async () => {
		await teardownHarper(ctx);
	});

	test('the LMDB source holds header audit refs and the catalog rows', async () => {
		const result = await verify('before compaction');
		ok(!/Rocks/.test(result.engine), `expected an LMDB store, got ${result.engine}`);
		assertComplete(result, 'before compaction');
	});

	test('compactOnStart keeps them', { timeout: BOOT_TIMEOUT_MS + 60_000 }, async () => {
		await killHarper(ctx);
		await startHarper(ctx, {
			config: { storage: { compactOnStart: true }, threads: { count: 1 } },
			env: { HARPER_STORAGE_ENGINE: 'lmdb' },
			startupTimeoutMs: BOOT_TIMEOUT_MS,
		});
		ok(/Running compact on start/.test(ctx.harper.startupOutput?.stdout ?? ''), 'compactOnStart did not run');
		const result = await verify('after compaction');
		ok(!/Rocks/.test(result.engine), `expected an LMDB store, got ${result.engine}`);
		assertComplete(result, 'after compaction');
	});

	test('migrateOnStart keeps them', { timeout: BOOT_TIMEOUT_MS + 60_000 }, async () => {
		await killHarper(ctx);
		await startHarper(ctx, {
			config: { storage: { migrateOnStart: true }, threads: { count: 1 } },
			env: {},
			startupTimeoutMs: BOOT_TIMEOUT_MS,
		});
		ok(
			/migrated database data to RocksDB/.test(ctx.harper.startupOutput?.stdout ?? ''),
			'migrateOnStart did not migrate the data database'
		);
		const result = await verify('after migration');
		ok(/Rocks/.test(result.engine), `expected a RocksDB store, got ${result.engine}`);
		assertComplete(result, 'after migration');
	});
});
