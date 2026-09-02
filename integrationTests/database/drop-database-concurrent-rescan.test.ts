/**
 * drop_database must not race a concurrent open of its RocksDB directory on another thread.
 *
 * Every schema change makes every thread rescan every database directory (syncSchemaMetadata →
 * resetDatabases), and a rescan that finds the `dropping` tombstone a drop_table on another thread
 * has just written treats that drop as interrupted and opens the table's column stores to finish it
 * — while the originating thread's drop_database is destroying the directory. Two outcomes are
 * visible from outside: the dropped database comes back (an empty directory the next rescan loads),
 * and every later open of that path in the process fails with `lock hold by current process`
 * (HarperFast/rocksdb-js#818), so job workers die at boot. Main flake signature 2, Integration Tests
 * run 33592149855 (uWS 2/6, terminology.test.mjs).
 *
 * This drives the same shape: many column families per table (one open per family in the
 * reconcile), several worker threads (one reconcile each), and a schema change fired into the
 * middle of every drop_table so the rescan lands while the tombstone exists. It pins the half
 * that is deterministic — every thread releases the dropped database when the drop is announced,
 * so a same-name recreate loads cleanly and a job worker still boots. The destroy-vs-open window
 * itself (the dropped directory reappearing, the LOCK held for the life of the process) is not
 * closed yet, so it is not asserted here.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error the apiTests helpers have no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error same
import { installAppComponent } from '../apiTests/utils/components.mjs';

const DATABASE = 'dropme';
const TABLE = 'todo';
const ATTRIBUTES = Array.from({ length: 12 }, (_, i) => `attr${i}`);
const ITERATIONS = 8;
const WORKERS = 3;
const JOB_TIMEOUT_MS = 30_000;
// Sorts after `dropme` in the scan: a thread whose rescan dies on the stale dropme handle never
// reaches it, which is what the probe below observes from inside a worker.
const LATE_DATABASE = 'zz-after-dropme';
const skipSuite = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// Served by an http worker, reporting that worker's own catalog: operations run on the main thread,
// so this is the only way to see what a worker's rescan actually loaded.
const PROBE_RESOURCES_JS =
	'export class CatalogProbe extends Resource {\n' +
	'\tstatic loadAsInstance = false;\n' +
	'\tget() {\n' +
	'\t\treturn Object.fromEntries(Object.keys(databases).sort().map((name) => [name, Object.keys(databases[name]).sort()]));\n' +
	'\t}\n' +
	'}\n';

suite('drop_database under concurrent schema rescans (rocksdb)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let authorization: string;

	async function operation(body: Record<string, unknown>): Promise<any> {
		const response = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const text = await response.text();
		strictEqual(response.status, 200, `${body.operation} ${body.database ?? ''}.${body.table ?? ''} failed: ${text}`);
		return JSON.parse(text);
	}

	async function awaitJob(jobId: string): Promise<any> {
		const deadline = Date.now() + JOB_TIMEOUT_MS;
		for (;;) {
			const [job] = await operation({ operation: 'get_job', id: jobId });
			if (job?.status === 'COMPLETE' || job?.status === 'ERROR') return job;
			ok(Date.now() < deadline, `job ${jobId} did not finish within ${JOB_TIMEOUT_MS}ms: ${JSON.stringify(job)}`);
			await sleep(250);
		}
	}

	async function workerCatalog(): Promise<Record<string, string[]>> {
		const response = await fetch(`${ctx.harper.httpURL}/CatalogProbe/`, { headers: { Authorization: authorization } });
		const text = await response.text();
		strictEqual(response.status, 200, `catalog probe failed: ${text}`);
		return JSON.parse(text);
	}

	before(async () => {
		await startHarper(ctx, {
			config: { threads: { count: WORKERS }, logging: { level: 'debug' } },
			env: { HARPER_STORAGE_ENGINE: 'rocksdb' },
		});
		authorization = `Basic ${Buffer.from(`${ctx.harper.admin.username}:${ctx.harper.admin.password}`).toString('base64')}`;
		await installAppComponent(createApiClient(ctx.harper), {
			project: 'catalog-probe',
			files: { 'config.yaml': 'jsResource:\n  files: resources.js\nrest: true\n', 'resources.js': PROBE_RESOURCES_JS },
			probePath: '/CatalogProbe/',
			restartTimeoutMs: 120_000,
		});
		await operation({ operation: 'create_table', database: 'data', table: 'anchor', primary_key: 'id' });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('every thread survives a database being dropped under it and recreated by name', async () => {
		for (let iteration = 0; iteration < ITERATIONS; iteration++) {
			await operation({ operation: 'create_database', database: DATABASE });
			await operation({ operation: 'create_table', database: DATABASE, table: TABLE, primary_key: 'id' });
			for (const attribute of ATTRIBUTES) {
				await operation({ operation: 'create_attribute', database: DATABASE, table: TABLE, attribute });
			}
			await operation({
				operation: 'insert',
				database: DATABASE,
				table: TABLE,
				records: [Object.fromEntries([['id', 1], ...ATTRIBUTES.map((attribute) => [attribute, iteration])])],
			});
			// The churn is what sends every other thread through a rescan while the tombstone exists.
			const churnTable = `churn_${iteration}`;
			const dropTable = operation({ operation: 'drop_table', database: DATABASE, table: TABLE });
			const churn = operation({
				operation: 'create_table',
				database: 'data',
				table: churnTable,
				primary_key: 'id',
			}).then(() => operation({ operation: 'drop_table', database: 'data', table: churnTable }));
			await dropTable;
			await operation({ operation: 'drop_database', database: DATABASE });
			await churn;
		}

		// Every thread's rescan must survive the database coming back under the same name: a thread
		// that kept a closed handle for the destroyed directory fails on it for every later schema
		// event, and every database the scan reaches after it stays invisible to that thread. The
		// schema operations return only after every worker acknowledged its rescan, so the worker
		// serving the probe has already run it.
		await operation({ operation: 'create_database', database: DATABASE });
		await operation({ operation: 'create_table', database: DATABASE, table: TABLE, primary_key: 'id' });
		await operation({ operation: 'create_database', database: LATE_DATABASE });
		await operation({ operation: 'create_table', database: LATE_DATABASE, table: 'probe', primary_key: 'id' });
		const catalog = await workerCatalog();
		deepStrictEqual(
			{ [DATABASE]: catalog[DATABASE], [LATE_DATABASE]: catalog[LATE_DATABASE] },
			{ [DATABASE]: [TABLE], [LATE_DATABASE]: ['probe'] },
			`a worker's rescan no longer loads the recreated database or anything after it: ${JSON.stringify(catalog)}`
		);

		// A job worker boots by opening every database; a wedged path kills it before the job starts.
		const started = await operation({
			operation: 'delete_records_before',
			database: 'data',
			table: 'anchor',
			date: '2050-01-01T00:00:00.000Z',
		});
		const job = await awaitJob(started.job_id);
		strictEqual(job.status, 'COMPLETE', `job after the drops did not complete: ${JSON.stringify(job)}`);
	});
});
