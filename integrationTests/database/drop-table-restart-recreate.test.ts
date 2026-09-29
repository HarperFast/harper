/**
 * A dropped table stays dropped across a restart, and a same-name recreate never shows the dropped
 * table's rows.
 *
 * Three ways to get the table back, each run once with a graceful restart and once with a SIGKILL
 * issued as soon as the last operation returns (so boot-time transaction-log replay and
 * interrupted-drop completion run over unflushed history):
 * - recreated in the same process, before the restart — the ghost-table incident flow
 *   (https://github.com/HarperFast/harper/pull/1246);
 * - recreated with `create_table` after the restart;
 * - defined in a component's `schema.graphql`, so the restart itself recreates it.
 *
 * Every arm then writes one fresh row and restarts again: only that row may be visible, through
 * both the primary store and a secondary index.
 *
 * Single-node half of https://github.com/HarperFast/harper/issues/1212. The case of a peer that
 * missed the drop needs replication, so it belongs in harper-pro.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'drop-table-restart-recreate');
const DATABASE = 'drop_restart';
const ROWS = 50;
const INDEXED_VALUE = 7;
const CONFIG = { logging: { level: 'error' as const } };
const EMPTY = { all: [], byIndex: [] };
const FRESH = { all: ['fresh'], byIndex: ['fresh'] };

type Recreate = 'before restart' | 'after restart' | 'by schema';

const CASES: { table: string; recreate: Recreate; crash: boolean }[] = [
	{ table: 'RecreatedAfterRestart', recreate: 'after restart', crash: false },
	{ table: 'RecreatedAfterRestartCrash', recreate: 'after restart', crash: true },
	{ table: 'SchemaDefinedGraceful', recreate: 'by schema', crash: false },
	{ table: 'SchemaDefinedCrash', recreate: 'by schema', crash: true },
	{ table: 'RecreatedInProcess', recreate: 'before restart', crash: false },
	{ table: 'RecreatedInProcessCrash', recreate: 'before restart', crash: true },
];

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() >= deadline) return false;
		await sleep(250);
	}
	return true;
}

suite(
	'drop_table survives restart; recreate starts empty (harper#1212)',
	{ timeout: 600_000 },
	(ctx: ContextWithHarper) => {
		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: CONFIG });
			for (const { table, recreate } of CASES) {
				if (recreate !== 'by schema') await createTable(table);
			}
			ok(await waitFor(async () => (await tableNames()).length === CASES.length), 'fixture tables did not load');
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		function operation(body: Record<string, unknown>) {
			return sendOperation(ctx.harper, body);
		}

		function createTable(table: string) {
			return operation({
				operation: 'create_table',
				database: DATABASE,
				table,
				primary_key: 'id',
				attributes: [
					{ name: 'id', type: 'ID' },
					{ name: 'n', type: 'Int', indexed: true },
				],
			});
		}

		async function tableNames(): Promise<string[]> {
			return Object.keys(await operation({ operation: 'describe_database', database: DATABASE }));
		}

		async function idsWhere(table: string, attribute: string, value: unknown): Promise<string[]> {
			const records = await operation({
				operation: 'search_by_value',
				database: DATABASE,
				table,
				attribute,
				value,
				get_attributes: ['id'],
			});
			return records.map((record: { id: string }) => record.id).sort();
		}

		async function contents(table: string) {
			return { all: await idsWhere(table, 'id', '*'), byIndex: await idsWhere(table, 'n', INDEXED_VALUE) };
		}

		async function restart(crash: boolean) {
			const { dataRootDir, hostname, process: harperProcess } = ctx.harper;
			if (crash) {
				ok(harperProcess.exitCode === null && harperProcess.signalCode === null, 'Harper exited before the kill');
			}
			await killHarper(ctx, crash ? { graceMs: 0 } : undefined);
			if (crash && process.platform !== 'win32') {
				strictEqual(harperProcess.signalCode, 'SIGKILL', 'Harper finished shutting down before SIGKILL landed');
			}
			(ctx as any).harper = { dataRootDir, hostname };
			await startHarper(ctx as any, { config: CONFIG });
		}

		function insertFresh(table: string) {
			return operation({
				operation: 'insert',
				database: DATABASE,
				table,
				records: [{ id: 'fresh', n: INDEXED_VALUE }],
			});
		}

		for (const { table, recreate, crash } of CASES) {
			test(`recreated ${recreate}, ${crash ? 'killed' : 'graceful restart'}`, async () => {
				const records = Array.from({ length: ROWS }, (_, n) => ({ id: `old-${n}`, n }));
				await operation({ operation: 'insert', database: DATABASE, table, records });
				deepStrictEqual((await contents(table)).byIndex, [`old-${INDEXED_VALUE}`]);

				await operation({ operation: 'drop_table', database: DATABASE, table });
				if (recreate === 'before restart') {
					await createTable(table);
					deepStrictEqual(await contents(table), EMPTY, 'in-process recreate holds pre-drop rows');
					await insertFresh(table);
				}
				await restart(crash);

				if (recreate === 'after restart') {
					ok(!(await tableNames()).includes(table), `${table} came back after restart without a create_table`);
					await createTable(table);
				} else {
					ok(await waitFor(async () => (await tableNames()).includes(table)), `${table} missing after restart`);
				}
				if (recreate !== 'before restart') {
					deepStrictEqual(await contents(table), EMPTY, 'recreated table holds pre-drop rows');
					await insertFresh(table);
				}
				deepStrictEqual(await contents(table), FRESH, 'pre-drop rows returned after restart');

				await restart(false);
				ok(await waitFor(async () => (await tableNames()).includes(table)), `${table} missing after second restart`);
				deepStrictEqual(await contents(table), FRESH, 'pre-drop rows returned after second restart');
			});
		}
	}
);
