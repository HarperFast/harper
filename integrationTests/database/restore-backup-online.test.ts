import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const DATABASE = 'restore_online';
const TABLE = 'Items';
const OTHER_TABLE = 'Other';
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';
const JOB_TIMEOUT_MS = 120_000;

suite(
	'online restore_backup after runtime schema changes (harper#3120)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		async function op(operation: Record<string, any>): Promise<any> {
			const { username, password } = ctx.harper.admin;
			const res = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
				},
				body: JSON.stringify(operation),
				signal: AbortSignal.timeout(60_000),
			});
			const text = await res.text();
			let body: any = text;
			try {
				body = JSON.parse(text);
			} catch {
				/* keep text */
			}
			return { status: res.status, body, text };
		}

		async function runJob(operation: Record<string, any>): Promise<any> {
			const started = await op(operation);
			strictEqual(started.status, 200, `${operation.operation} rejected: ${started.text}`);
			const jobId = /Starting job with id ([\w-]+)/.exec(started.body?.message ?? '')?.[1];
			ok(jobId, `no job id in ${started.text}`);
			const deadline = Date.now() + JOB_TIMEOUT_MS;
			let last = '';
			while (Date.now() < deadline) {
				const r = await op({ operation: 'get_job', id: jobId });
				const record = Array.isArray(r.body) ? r.body[0] : r.body;
				if (record?.status === 'COMPLETE' || record?.status === 'ERROR') return record;
				last = r.text.slice(0, 300);
				await sleep(500);
			}
			throw new Error(`job ${jobId} did not settle within ${JOB_TIMEOUT_MS}ms; last=${last}`);
		}

		async function insert(table: string, records: Record<string, any>[]): Promise<void> {
			const r = await op({ operation: 'insert', database: DATABASE, table, records });
			strictEqual(r.status, 200, `insert into ${table} failed: ${r.text}`);
		}

		async function ids(table: string): Promise<string> {
			const r = await op({
				operation: 'search_by_value',
				database: DATABASE,
				table,
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['id'],
			});
			strictEqual(r.status, 200, `search of ${table} failed: ${r.text}`);
			return r.body
				.map((row: any) => row.id)
				.sort()
				.join(',');
		}

		before(async () => {
			await startHarper(ctx, { config: { threads: { count: 3 }, logging: { console: true, level: 'error' } } });
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('restores online and returns the backed-up rows', async () => {
			for (const table of [TABLE, OTHER_TABLE]) {
				const created = await op({ operation: 'create_table', database: DATABASE, table, primary_key: 'id' });
				strictEqual(created.status, 200, `create_table ${table} failed: ${created.text}`);
			}
			// `note` and `extra` are attributes the tables never declared, so each insert redeclares its table
			await insert(TABLE, [
				{ id: 'a', note: 'kept' },
				{ id: 'b', note: 'kept' },
			]);
			await insert(OTHER_TABLE, [{ id: 'x', note: 'kept' }]);
			const backup = await runJob({ operation: 'create_backup', database: DATABASE });
			strictEqual(backup.status, 'COMPLETE', `create_backup failed: ${JSON.stringify(backup)}`);
			const backupId = backup.result?.backup_id ?? backup.message?.backup_id;
			ok(Number.isInteger(backupId), `no backup_id in ${JSON.stringify(backup)}`);
			await insert(TABLE, [{ id: 'c', extra: 'after the backup' }]);

			const restore = await runJob({ operation: 'restore_backup', database: DATABASE, backup_id: backupId });

			strictEqual(restore.status, 'COMPLETE', `online restore_backup failed: ${JSON.stringify(restore)}`);
			strictEqual(await ids(TABLE), 'a,b');
			strictEqual(await ids(OTHER_TABLE), 'x');
		});
	}
);
