/**
 * A backup must hold what the table stores held when it was taken, not only what RocksDB had already
 * flushed. Table stores are opened without a write-ahead log, and an eviction is a removal the
 * transaction-log replay cannot reconstruct, so until a flush it exists only in the memtable. A backup
 * that skips the flush keeps the evicted record from an older table file, while the blob snapshot, taken
 * from the live files, no longer has its blob: restore_backup then refuses the backup for the missing
 * blob.
 *
 * The table-file assertions read the backup with a plain `@harperfast/rocksdb-js` handle, which
 * replays no transaction log: a record is there only if the backup's own table files hold it.
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { RocksDatabase, backups } from '@harperfast/rocksdb-js';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const run = promisify(execFile);
const FIXTURE_PATH = resolve(import.meta.dirname, 'backup-flushes-table-stores');
const DATABASE = 'backup_flush';
const BLOB_TABLE = 'Blobs';
const PLAIN_TABLE = 'Plain';
const BLOB_BYTES = 64 * 1024;
const JOB_TIMEOUT_MS = 120_000;
const RECLAIM_TIMEOUT_MS = 30_000;
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

function parseBody(text: string): any {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

suite(
	'a backup holds evictions and writes that RocksDB had not flushed',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let managedBackupId: number;

		function request(url: string, body: Record<string, any>): Promise<Response> {
			const { username, password } = ctx.harper.admin;
			return fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(60_000),
			});
		}

		async function post(url: string, body: Record<string, any>): Promise<{ status: number; body: any; text: string }> {
			const res = await request(url, body);
			const text = await res.text();
			return { status: res.status, body: parseBody(text), text };
		}

		const op = (operation: Record<string, any>) => post(ctx.harper.operationsAPIURL, operation);

		async function fixture(body: Record<string, any>): Promise<any> {
			const r = await post(`${ctx.harper.httpURL}/BackupFlushOps/`, body);
			strictEqual(r.status, 200, `${body.action} failed: ${r.text}`);
			return r.body;
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

		async function ids(table: string): Promise<string[]> {
			const r = await op({
				operation: 'search_by_value',
				database: DATABASE,
				table,
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['id'],
			});
			strictEqual(r.status, 200, `search of ${table} failed: ${r.text}`);
			return r.body.map((row: any) => row.id).sort();
		}

		function blobFileCount(): number {
			const root = join(ctx.harper.dataRootDir, 'blobs', DATABASE);
			if (!existsSync(root)) return 0;
			return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
		}

		async function evictThenWrite(prefix: string): Promise<void> {
			await fixture({ action: 'putBlob', table: BLOB_TABLE, id: `${prefix}-kept` });
			await fixture({ action: 'putBlob', table: BLOB_TABLE, id: `${prefix}-evicted` });
			// the evicted record is in a table file before its eviction, which is then the only unflushed change to it
			await fixture({ action: 'flush', table: BLOB_TABLE });
			const filesBefore = blobFileCount();
			ok(filesBefore >= 2, `both blobs must be file-backed; found ${filesBefore} blob files`);
			deepStrictEqual(await fixture({ action: 'evict', table: BLOB_TABLE, id: `${prefix}-evicted` }), {
				evicted: true,
			});
			const deadline = Date.now() + RECLAIM_TIMEOUT_MS;
			while (blobFileCount() !== filesBefore - 1) {
				ok(Date.now() < deadline, `the evicted record's blob file was not reclaimed within ${RECLAIM_TIMEOUT_MS}ms`);
				await sleep(50);
			}
			const inserted = await op({
				operation: 'insert',
				database: DATABASE,
				table: PLAIN_TABLE,
				records: [{ id: `${prefix}-late` }],
			});
			strictEqual(inserted.status, 200, `insert failed: ${inserted.text}`);
		}

		function tableFileKeys(databaseDir: string, table: string): string[] {
			const root = RocksDatabase.open(databaseDir, { readOnly: true });
			let name: string | undefined;
			try {
				name = root.columns.find((column) => column === `${table}/` || column.startsWith(`${table}/@`));
			} finally {
				root.close();
			}
			ok(name, `${databaseDir} has no primary store for ${table}`);
			const store = RocksDatabase.open(databaseDir, { name, readOnly: true });
			try {
				return [...store.getKeys()].map(String).sort();
			} finally {
				store.close();
			}
		}

		function assertTableFilesHold(databaseDir: string, prefix: string): void {
			const blobKeys = tableFileKeys(databaseDir, BLOB_TABLE).filter((key) => key.startsWith(`${prefix}-`));
			deepStrictEqual(
				blobKeys,
				[`${prefix}-kept`],
				'the table files must hold the kept record and not the evicted one'
			);
			const plainKeys = tableFileKeys(databaseDir, PLAIN_TABLE).filter((key) => key.startsWith(`${prefix}-`));
			deepStrictEqual(plainKeys, [`${prefix}-late`], 'the table files must hold the record written just before');
		}

		function scratchDir(name: string): string {
			const dir = join(ctx.harper.dataRootDir, 'backup-flush-scratch', name);
			mkdirSync(dir, { recursive: true });
			return dir;
		}

		// the backups root is configurable, so find the repository by its engine directory for this backup
		function backupRepository(id: number): string {
			const root = ctx.harper.dataRootDir;
			for (const top of readdirSync(root)) {
				if (existsSync(join(root, top, DATABASE, 'private', String(id)))) return join(root, top, DATABASE);
			}
			throw new Error(`no backup repository for ${DATABASE}#${id} under ${root}`);
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				// blobRetention 0 reclaims an evicted record's blob as soon as its removal commits
				config: { threads: { count: 2 }, storage: { blobRetention: 0 }, logging: { console: true, level: 'error' } },
			});
			// declared in full up front, so no write redeclares a table
			for (const [table, attributes] of [
				[
					BLOB_TABLE,
					[
						{ name: 'id', is_primary_key: true },
						{ name: 'data', type: 'Blob' },
					],
				],
				[PLAIN_TABLE, [{ name: 'id', is_primary_key: true }]],
			] as const) {
				const created = await op({
					operation: 'create_table',
					database: DATABASE,
					table,
					primary_key: 'id',
					attributes,
				});
				strictEqual(created.status, 200, `create_table ${table} failed: ${created.text}`);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('create_backup', async () => {
			await evictThenWrite('managed');
			const backup = await runJob({ operation: 'create_backup', database: DATABASE });
			strictEqual(backup.status, 'COMPLETE', `create_backup failed: ${JSON.stringify(backup)}`);
			managedBackupId = backup.result?.backup_id ?? backup.message?.backup_id;
			ok(Number.isInteger(managedBackupId), `no backup_id in ${JSON.stringify(backup)}`);

			const restored = scratchDir('managed');
			await backups.restore(backupRepository(managedBackupId), restored, { backupId: managedBackupId });
			assertTableFilesHold(restored, 'managed');
		});

		test('get_backup', async () => {
			// its own writes: the backup above flushed everything written before it
			await evictThenWrite('archive');
			const res = await request(ctx.harper.operationsAPIURL, { operation: 'get_backup', database: DATABASE });
			strictEqual(res.status, 200, `get_backup rejected: ${res.status}`);
			const extracted = scratchDir('archive');
			const archive = join(extracted, '..', 'archive.tar.gz');
			await pipeline(Readable.fromWeb(res.body as any), createWriteStream(archive));
			await run('tar', ['-xzf', archive, '-C', extracted]);

			assertTableFilesHold(extracted, 'archive');
		});

		test('restore_backup restores the create_backup taken right after an eviction', async () => {
			ok(managedBackupId, 'create_backup must have produced a backup');
			const restore = await runJob({ operation: 'restore_backup', database: DATABASE, backup_id: managedBackupId });

			strictEqual(restore.status, 'COMPLETE', `restore_backup failed: ${JSON.stringify(restore)}`);
			deepStrictEqual(await ids(BLOB_TABLE), ['managed-kept']);
			deepStrictEqual(await ids(PLAIN_TABLE), ['managed-late']);
			deepStrictEqual(await fixture({ action: 'blobSize', table: BLOB_TABLE, id: 'managed-kept' }), {
				size: BLOB_BYTES,
			});
		});
	}
);
