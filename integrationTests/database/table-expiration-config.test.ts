/**
 * A table's TTL configuration on every thread that holds the table: the threads that declare it, the threads
 * that only load it from the catalog, and the main thread under `threads: 0`, across restarts, on RocksDB and
 * LMDB (harper#1286, #2831, #3372, #3934, #3935).
 *
 * The cleanup scan runs on the store-maintenance owner, the last worker. A table created by `create_table`, or
 * declared through the fixture's TtlControl endpoint on another worker, reaches the owner only through the
 * catalog. Under `threads: 0` the main thread loads every table before it becomes worker 0.
 *
 * Expiration and eviction are 2 s each (8 s on the tables that live across a restart), so the derived scan
 * interval is (2 + 2) / 4 = 1 s (4 s).
 *
 * Reproduction:
 *   npm run build && npm run test:integration -- "integrationTests/database/table-expiration-config.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startHarper, killHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE = 'table-expiration-config';
const NEGATIVE_FIXTURE = 'table-expiration-config-negative';
const DATABASE = 'ttl_config';
const EXPIRATION = 2;
const EVICTION = 2;
const ROWS = 5;
// Tables that live across a restart use a longer TTL, so their rows only become evictable after the restart and
// only the restarted process can reclaim them. Derived scan interval (8 + 8) / 4 = 4 s.
const RUNTIME_EXPIRATION = 8;
const RUNTIME_EVICTION = 8;
const RECLAIM_MARGIN_MS = 15_000;
// past expiration + eviction plus three scans, so a TTL still in effect would have hidden and reclaimed the rows
const CLEARED_HOLD_MS = (EXPIRATION + EVICTION) * 1000 + 3_000;

interface OperationResult {
	status: number;
	body: any;
}

async function operation(ctx: ContextWithHarper, body: Record<string, unknown>): Promise<OperationResult> {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': basicAuth(ctx),
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	let parsed: any = text;
	try {
		parsed = JSON.parse(text);
	} catch {
		// not JSON
	}
	return { status: response.status, body: parsed };
}

async function ok200(ctx: ContextWithHarper, body: Record<string, unknown>) {
	const result = await operation(ctx, body);
	strictEqual(result.status, 200, `${body.operation} failed: ${JSON.stringify(result.body)}`);
	return result.body;
}

// describe_table counts stored entries without a query or GET, so it neither hides nor touches expired rows
async function storedRows(ctx: ContextWithHarper, table: string): Promise<number> {
	return (await ok200(ctx, { operation: 'describe_table', database: DATABASE, table })).record_count;
}

async function waitForReclaim(ctx: ContextWithHarper, table: string, dueAt: number, why: string) {
	const deadline = dueAt + RECLAIM_MARGIN_MS;
	let count: number;
	do {
		await sleep(500);
		count = await storedRows(ctx, table);
	} while (count > 0 && Date.now() < deadline);
	strictEqual(
		count,
		0,
		`${count} rows of ${table} still stored ${RECLAIM_MARGIN_MS / 1000}s after they were due: ${why}`
	);
}

async function insertRows(ctx: ContextWithHarper, table: string) {
	const records = Array.from({ length: ROWS }, (_, i) => ({ id: String(i), value: `v${i}` }));
	await ok200(ctx, { operation: 'insert', database: DATABASE, table, records });
}

const basicAuth = (ctx: ContextWithHarper) =>
	`Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;

// a fresh connection per request, so retries reach different workers
function http(
	ctx: ContextWithHarper,
	method: string,
	path: string,
	body?: Record<string, unknown>
): Promise<{ status: number; text: string }> {
	const payload = body === undefined ? undefined : JSON.stringify(body);
	return new Promise((resolveRequest, reject) => {
		const req = httpRequest(
			new URL(path, ctx.harper.httpURL),
			{
				method,
				agent: false,
				headers: {
					Authorization: basicAuth(ctx),
					...(payload === undefined
						? {}
						: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk) => chunks.push(chunk));
				res.on('end', () => resolveRequest({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
			}
		);
		req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${path}: no response`)));
		req.on('error', reject);
		req.end(payload);
	});
}

async function control(ctx: ContextWithHarper, body: Record<string, unknown>): Promise<any> {
	const { status, text } = await http(ctx, 'POST', '/TtlControl/', body);
	if (status !== 200) throw new Error(`TtlControl ${body.op}: ${status} ${text}`);
	return JSON.parse(text);
}

async function untilServed(ctx: ContextWithHarper, body: Record<string, unknown>) {
	const deadline = Date.now() + 60_000;
	for (;;) {
		const result = await control(ctx, body);
		if (!result.wrongThread) return result;
		if (Date.now() > deadline) throw new Error(`TtlControl ${body.op} never reached a worker that could serve it`);
		await sleep(10);
	}
}

const workerTtl = (ctx: ContextWithHarper, table: string, worker: number) =>
	untilServed(ctx, { op: 'ttl', table, onWorker: worker });

async function waitForWorkerTtl(
	ctx: ContextWithHarper,
	table: string,
	worker: number,
	expected: { expirationMS: number; evictionMS: number }
) {
	const deadline = Date.now() + 20_000;
	let seen: any;
	do {
		seen = await workerTtl(ctx, table, worker);
		if (seen.loaded && seen.expirationMS === expected.expirationMS && seen.evictionMS === expected.evictionMS) return;
		await sleep(200);
	} while (Date.now() < deadline);
	throw new Error(`worker ${worker} holds ${JSON.stringify(seen)} for ${table}, expected ${JSON.stringify(expected)}`);
}

async function assertRowsKept(ctx: ContextWithHarper, table: string, why: string) {
	await sleep(CLEARED_HOLD_MS);
	strictEqual(await storedRows(ctx, table), ROWS, `rows of ${table} were reclaimed on: ${why}`);
	for (let i = 0; i < ROWS * 4; i++) {
		const { status } = await http(ctx, 'GET', `/${table}/${i % ROWS}`);
		strictEqual(status, 200, `GET /${table}/${i % ROWS} was hidden as expired on: ${why}`);
	}
}

// Every check after a restart runs, so a failure reports all of them, not only the first.
function softChecks() {
	const failures: string[] = [];
	return {
		async check(run: () => Promise<unknown>) {
			try {
				await run();
			} catch (error) {
				failures.push((error as Error).message);
			}
		},
		assertNone() {
			strictEqual(failures.length, 0, `${failures.length} checks failed:\n- ${failures.join('\n- ')}`);
		},
	};
}

async function stage(fixtures: string[]) {
	const dataRootDir = await mkdtemp(
		join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
	);
	for (const fixture of fixtures)
		await cp(resolve(import.meta.dirname, fixture), join(dataRootDir, 'components', fixture), {
			recursive: true,
			dereference: true,
		});
	return dataRootDir;
}

async function dropDeclaredTtl(ctx: ContextWithHarper) {
	const schemaPath = join(ctx.harper.dataRootDir, 'components', FIXTURE, 'schema.graphql');
	const schema = await readFile(schemaPath, 'utf8');
	const cleared = schema.replace(`, expiration: ${EXPIRATION}, eviction: ${EVICTION}`, '');
	ok(cleared !== schema, 'the fixture schema no longer declares the TTL this test removes');
	await writeFile(schemaPath, cleared);
}

async function createRuntimeTtl(ctx: ContextWithHarper) {
	await ok200(ctx, {
		operation: 'create_table',
		database: DATABASE,
		table: 'RuntimeTtl',
		primary_key: 'id',
		expiration: RUNTIME_EXPIRATION,
		eviction: RUNTIME_EVICTION,
	});
}

async function restartWithoutDeclaredTtl(ctx: ContextWithHarper, options: Record<string, unknown>, dueAt: number) {
	await killHarper(ctx);
	await dropDeclaredTtl(ctx);
	await startHarper(ctx, options);
	ok(Date.now() < dueAt, 'the restart outlasted the runtime TTL, so it cannot show which process reclaimed the rows');
}

async function assertDeclaredTtlRemoved(ctx: ContextWithHarper) {
	const described = await ok200(ctx, { operation: 'describe_table', database: DATABASE, table: 'Declared' });
	strictEqual(described.expiration, undefined, 'describe_table (the main thread) still reports the removed expiration');
	await insertRows(ctx, 'Declared');
	await assertRowsKept(ctx, 'Declared', 'a schema whose TTL was removed, after a restart');
}

for (const engine of ['rocksdb', 'lmdb']) {
	const env = engine === 'lmdb' ? { HARPER_STORAGE_ENGINE: 'lmdb' } : {};

	suite(`Table TTL configuration with four workers (${engine})`, (ctx: ContextWithHarper) => {
		const THREADS = 4;
		const OWNER = THREADS - 1;
		const options = { config: { threads: { count: THREADS } }, env };

		before(async () => {
			ctx.harper = { dataRootDir: await stage([FIXTURE, NEGATIVE_FIXTURE]) } as any;
			await startHarper(ctx, options);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('a negative TTL fails where it is declared, naming the table and field (#1286, #3935)', async () => {
			const name = `${NEGATIVE_FIXTURE}.graphqlSchema`;
			const deadline = Date.now() + 30_000;
			let entry: any;
			do {
				const status = await ok200(ctx, { operation: 'get_status' });
				entry = status.componentStatus?.find((candidate: any) => candidate.name === name);
				if (entry?.status === 'error') break;
				await sleep(250);
			} while (Date.now() < deadline);
			strictEqual(
				entry?.status,
				'error',
				`@table(expiration: -1) did not fail its component: ${JSON.stringify(entry)}`
			);
			const reported = JSON.stringify(entry);
			ok(!/timed out/i.test(reported), `the component failed on a timeout instead of the TTL: ${reported}`);
			ok(
				/expiration/.test(reported) && reported.includes('ttl_config_bad.NegativeTtl'),
				`the failure does not name the table and field: ${reported}`
			);

			for (const [field, table] of [
				['eviction', 'NegativeEviction'],
				['expiration', 'NegativeExpiration'],
			]) {
				const created = await operation(ctx, {
					operation: 'create_table',
					database: DATABASE,
					table,
					primary_key: 'id',
					[field]: -1,
				});
				strictEqual(created.status, 400, `create_table with ${field}: -1 returned ${JSON.stringify(created)}`);
				const error = JSON.stringify(created.body);
				ok(
					error.includes(field) && error.includes(`${DATABASE}.${table}`),
					`create_table does not name the table and field: ${error}`
				);
				const described = await operation(ctx, { operation: 'describe_table', database: DATABASE, table });
				ok(described.status !== 200, `a rejected create_table left ${table} behind`);
			}
		});

		test('the declaring thread reclaims expired rows on the derived cadence', { timeout: 60_000 }, async () => {
			await insertRows(ctx, 'Declared');
			await waitForReclaim(ctx, 'Declared', Date.now() + (EXPIRATION + EVICTION) * 1000, 'a schema-declared TTL');
		});

		test('an eviction-only TTL adopted from the catalog reclaims rows (#3935)', { timeout: 120_000 }, async () => {
			const table = 'AdoptedEviction';
			const { workerIndex } = await untilServed(ctx, { op: 'declare', table, avoidWorker: OWNER });
			// loaded before it gains a TTL, so the owner adopts the TTL instead of loading the table fresh with it
			await waitForWorkerTtl(ctx, table, OWNER, { expirationMS: 0, evictionMS: 0 });
			await untilServed(ctx, { op: 'declare', table, eviction: EVICTION, onWorker: workerIndex });
			await waitForWorkerTtl(ctx, table, OWNER, { expirationMS: 0, evictionMS: EVICTION * 1000 });
			await untilServed(ctx, { op: 'write', table, count: ROWS, expiresInMs: 500 });
			await waitForReclaim(ctx, table, Date.now() + 500 + EVICTION * 1000, 'an eviction-only TTL the owner adopted');
		});

		// both declarations on one worker: a worker keeps a TTL its own declaration set, as a restart re-applies it
		test('a re-declaration without a TTL clears it on every worker (#3934)', { timeout: 120_000 }, async () => {
			const table = 'AdoptedClear';
			const declared = { expirationMS: EXPIRATION * 1000, evictionMS: EVICTION * 1000 };
			const { workerIndex } = await untilServed(ctx, {
				op: 'declare',
				table,
				expiration: EXPIRATION,
				eviction: EVICTION,
				avoidWorker: OWNER,
			});
			for (let worker = 0; worker < THREADS; worker++) await waitForWorkerTtl(ctx, table, worker, declared);
			await untilServed(ctx, { op: 'declare', table, onWorker: workerIndex });
			const checks = softChecks();
			for (let worker = 0; worker < THREADS; worker++)
				await checks.check(() => waitForWorkerTtl(ctx, table, worker, { expirationMS: 0, evictionMS: 0 }));
			checks.assertNone();
		});

		test(
			'after a restart: a runtime table is reclaimed without a write, and a removed @table TTL stays removed (#3372, #3934)',
			{ timeout: 180_000 },
			async () => {
				const checks = softChecks();
				await createRuntimeTtl(ctx);
				await insertRows(ctx, 'RuntimeTtl');
				const dueAt = Date.now() + (RUNTIME_EXPIRATION + RUNTIME_EVICTION) * 1000;
				await restartWithoutDeclaredTtl(ctx, options, dueAt);

				await checks.check(() => waitForReclaim(ctx, 'RuntimeTtl', dueAt, 'a runtime-created table, no write'));
				for (let worker = 0; worker < THREADS; worker++)
					await checks.check(() => waitForWorkerTtl(ctx, 'Declared', worker, { expirationMS: 0, evictionMS: 0 }));
				await checks.check(() => assertDeclaredTtlRemoved(ctx));
				checks.assertNone();
			}
		);
	});

	suite(`Table TTL configuration with threads: 0 (${engine})`, (ctx: ContextWithHarper) => {
		const options = { config: { threads: { count: 0 } }, env };

		before(async () => {
			ctx.harper = { dataRootDir: await stage([FIXTURE]) } as any;
			await startHarper(ctx, options);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test(
			'after a restart, the main thread reclaims catalog-loaded tables without a write and keeps a removed TTL removed (#2831, #3934, #3935)',
			{ timeout: 180_000 },
			async () => {
				const checks = softChecks();
				strictEqual((await ok200(ctx, { operation: 'get_configuration' })).threads.count, 0);
				await createRuntimeTtl(ctx);
				await ok200(ctx, {
					operation: 'create_table',
					database: DATABASE,
					table: 'RuntimeEviction',
					primary_key: 'id',
					eviction: RUNTIME_EVICTION,
				});
				await checks.check(() =>
					waitForWorkerTtl(ctx, 'RuntimeEviction', 0, { expirationMS: 0, evictionMS: RUNTIME_EVICTION * 1000 })
				);
				await insertRows(ctx, 'RuntimeTtl');
				const expiresInMs = RUNTIME_EXPIRATION * 1000;
				await untilServed(ctx, { op: 'write', table: 'RuntimeEviction', count: ROWS, expiresInMs });
				const dueAt = Date.now() + (RUNTIME_EXPIRATION + RUNTIME_EVICTION) * 1000;
				await restartWithoutDeclaredTtl(ctx, options, dueAt);

				await checks.check(() => waitForReclaim(ctx, 'RuntimeTtl', dueAt, 'a runtime-created table, no write'));
				await checks.check(() => waitForReclaim(ctx, 'RuntimeEviction', dueAt, 'an eviction-only runtime table'));
				await checks.check(() => waitForWorkerTtl(ctx, 'Declared', 0, { expirationMS: 0, evictionMS: 0 }));
				await checks.check(() => assertDeclaredTtlRemoved(ctx));
				checks.assertNone();
			}
		);
	});
}
