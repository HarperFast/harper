/**
 * QA-816 — permanent anchor for the transaction-log purge blast radius (promoted from dispatch QA
 * finding qa-wave-2026072616).
 *
 * `delete_transaction_logs_before` on RocksDB deletes whole native transaction-log files, and a
 * RocksDB transaction log is per-DATABASE, not per-table: `RocksTransactionLogStore` is
 * constructed once per root database (`resources/auditStore.ts`), and the purge walks the database
 * and stops after the first RocksDB table because "all tables share the same transaction log
 * store" (`dataLayer/harperBridge/ResourceBridge.ts`). The live measurement behind this file found
 * that the resulting audit loss is (a) database-scoped — a quiet table in the SAME database as a
 * churning sibling lost 30/30 of its audit entries while a table in a different database kept
 * 30/30 — and (b) confined to audit history: 500/500 primary rows survived every read surface
 * across two clean restarts of the purged instance.
 *
 * THE INVARIANT PINNED HERE is (b): a purge may destroy audit history, and only audit history.
 * Every primary record in the purged database survives the purge and every subsequent restart,
 * value-exact on every read surface, and no database other than the purged one loses audit
 * entries. Any future purge change that escalates from audit loss to primary-data loss goes red.
 *
 * Half (a) is asserted only in the direction that stays true under improvement. "A different
 * database never loses audit entries" is a real invariant and is asserted. "A quiet same-database
 * sibling loses its audit" is a consequence of one native log per database that a future per-table
 * purge granularity would legitimately remove, so it is reported in the findings block and not
 * asserted; only that sibling's PRIMARY rows are asserted intact.
 *
 * ARMING. A purge that deletes nothing would make every survival assertion vacuously true, and a
 * control database whose entries merely sit in an unsealed active file would "survive" a purge
 * that leaked across databases. So BOTH databases are churned until their shared log rotates and
 * both are flushed before the cutoff is taken: the native purge only deletes log files entirely
 * before the last-flushed-to-RocksDB position (`resources/auditStore.ts`, `purgeAgedLogs`), so a
 * sealed-and-flushed oldest file is what makes each log genuinely purge-eligible. `purgeableFiles`
 * is deliberately NOT the arming signal — it counts eligibility under the 3-day retention policy
 * and is 0 for freshly written files regardless of the explicit cutoff the operation passes.
 *
 * PROOF BOUNDARY. Two clean restarts prove persisted reopen/replay behavior. This file does not
 * prove anything about a crash during the purge, writes racing the cutoff, replication, or LMDB.
 * LMDB is excluded by construction: it keeps a log per table, and a database-scoped purge there is
 * a no-op (the purge loop only handles RocksDB tables), so an LMDB arm would assert survival after
 * a purge that never ran. Equality on the read surfaces is value-exact over every seeded field,
 * not literal on-disk byte identity.
 *
 * Reproduction:
 *   cd <harper checkout> && npm run build && npm run test:integration -- \
 *     "integrationTests/database/qa816-purge-blast-radius.test.ts"
 *
 * Related: rocksdb-js#808 (purge-wedge root cause), harper#846, harper#2049 (the table-scoped
 * purge refusal that this file's database-scoped call routes around).
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	killHarper,
	startHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa816-purge-blast-radius');
const PURGED_DB = 'qa816a';
const CONTROL_DB = 'qa816b';
const skipSuite = process.env.HARPER_RUNTIME === 'bun';

const LEDGER_COUNT = 500;
const QUIET_COUNT = 30;
const REMOTE_COUNT = 30;
const LEDGER_SAMPLE_COUNT = 8;
const SEED_BATCH = 250;

const CHURN_PAYLOAD = 'c'.repeat(64 * 1024);
const CHURN_BATCH = 16;
const CHURN_BATCH_BYTES = CHURN_BATCH * CHURN_PAYLOAD.length;
const DEFAULT_MAX_FILE_SIZE = 16 * 1024 * 1024;

interface SeededRow {
	id: string;
	bucket: string;
	seq: number;
	payload: string;
}

interface LogInfo {
	path: string;
	fileCount: number;
	oldestSequenceNumber: number;
	currentSequenceNumber: number;
	lastFlushedSequence: number;
	rotations: number;
	filesPurged: number;
	entriesWritten: number;
	maxFileSize: number;
}

interface TableTopology {
	database: string;
	table: string;
	engineGuess: string;
	auditStoreId: number;
	logId: number;
	log: LogInfo | null;
}

type Topology = Record<string, TableTopology>;

function protectedRows(prefix: string, bucket: string, count: number): SeededRow[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `${prefix}-${i}`,
		bucket,
		seq: i,
		payload: `${prefix}:${i}:${'p'.repeat(48)}`,
	}));
}

const LEDGER_ROWS = protectedRows('ledger', 'LEDGER', LEDGER_COUNT);
const QUIET_ROWS = protectedRows('quiet', 'QUIET', QUIET_COUNT);
const REMOTE_ROWS = protectedRows('remote', 'REMOTE', REMOTE_COUNT);
const LEDGER_SAMPLE_IDS = Array.from(
	{ length: LEDGER_SAMPLE_COUNT },
	(_, i) => LEDGER_ROWS[Math.floor((i * LEDGER_COUNT) / LEDGER_SAMPLE_COUNT)].id
);
const LEDGER_AUDIT_SAMPLE_IDS = Array.from(
	{ length: 40 },
	(_, i) => LEDGER_ROWS[Math.floor((i * LEDGER_COUNT) / 40)].id
);

function authHeader(ctx: ContextWithHarper): string {
	const { username, password } = ctx.harper.admin;
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function rawOp(
	ctx: ContextWithHarper,
	operation: any,
	timeoutMs = 60_000
): Promise<{ status: number; body: any; text: string }> {
	const res = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': authHeader(ctx) },
		body: JSON.stringify(operation),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let body: any;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body, text };
}

async function restJson(
	ctx: ContextWithHarper,
	path: string,
	init: RequestInit = {},
	timeoutMs = 120_000
): Promise<{ status: number; body: any }> {
	const res = await fetch(`${ctx.harper.httpURL}${path}`, {
		...init,
		headers: { Authorization: authHeader(ctx), ...(init.headers ?? {}) },
		signal: AbortSignal.timeout(timeoutMs),
	});
	let body: any = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	return { status: res.status, body };
}

// Ready means the probe answers 200. A 404 is the fixture still loading; anything else (500 from a
// half-started server, 401 before auth is up) would otherwise read as "ready" and surface later as
// an opaque failure in whichever operation ran next.
async function pollReadiness(ctx: ContextWithHarper): Promise<void> {
	const deadline = Date.now() + 90_000;
	let last = 'no response';
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${ctx.harper.httpURL}/Probe/`, {
				headers: { Authorization: authHeader(ctx) },
				signal: AbortSignal.timeout(5_000),
			});
			if (res.status === 200) return;
			last = `HTTP ${res.status}`;
		} catch (error) {
			last = String((error as Error)?.message ?? error);
		}
		await sleep(250);
	}
	throw new Error(`QA-816: Probe route never answered 200 within 90s; last=${last}`);
}

async function pollJob(ctx: ContextWithHarper, jobId: string, timeoutMs = 120_000): Promise<any> {
	const deadline = Date.now() + timeoutMs;
	let last: any;
	while (Date.now() < deadline) {
		const r = await rawOp(ctx, { operation: 'get_job', id: jobId });
		strictEqual(r.status, 200, `get_job(${jobId}) failed with ${r.status}: ${r.text.slice(0, 300)}`);
		last = Array.isArray(r.body) ? r.body[0] : r.body;
		ok(last && typeof last === 'object', `get_job(${jobId}) returned a malformed record: ${r.text.slice(0, 300)}`);
		if (last.status === 'COMPLETE' || last.status === 'ERROR') return last;
		await sleep(500);
	}
	throw new Error(`QA-816: job ${jobId} did not settle within ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

async function topology(ctx: ContextWithHarper): Promise<Topology> {
	const r = await restJson(ctx, '/LogTopology/');
	strictEqual(r.status, 200, `/LogTopology/ expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
	return r.body as Topology;
}

function logOf(topo: Topology, database: string, table: string): LogInfo {
	const entry = topo[`${database}.${table}`];
	ok(entry?.log, `QA-816: no transaction-log stats for ${database}.${table}: ${JSON.stringify(entry)}`);
	return entry.log;
}

async function flushDatabase(ctx: ContextWithHarper, database: string): Promise<void> {
	const r = await restJson(ctx, `/Flush/?database=${database}`, { method: 'POST' });
	strictEqual(r.status, 200, `/Flush/ ${database} expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
	strictEqual(r.body?.flushed, true, `/Flush/ ${database} must actually flush, got ${JSON.stringify(r.body)}`);
}

/**
 * Flush until the log's oldest file is both sealed and fully applied to RocksDB — the two
 * conditions that make it eligible for the native purge. The last-flushed position cannot pass an
 * unflushed column family, and RocksDB's own size-triggered flushes race the test, so this is
 * polled rather than asserted after a single flush.
 */
async function flushUntilPurgeable(ctx: ContextWithHarper, database: string, table: string): Promise<LogInfo> {
	const deadline = Date.now() + 60_000;
	let log: LogInfo;
	do {
		await flushDatabase(ctx, database);
		log = logOf(await topology(ctx), database, table);
		if (log.oldestSequenceNumber < log.currentSequenceNumber && log.lastFlushedSequence > log.oldestSequenceNumber)
			return log;
		await sleep(250);
	} while (Date.now() < deadline);
	throw new Error(
		`ORACLE ARMING: ${database}'s oldest transaction-log file never became sealed and fully flushed within 60s ` +
			`(oldest=${log.oldestSequenceNumber} current=${log.currentSequenceNumber} lastFlushed=${log.lastFlushedSequence})`
	);
}

async function insertRows(ctx: ContextWithHarper, database: string, table: string, rows: SeededRow[]): Promise<void> {
	for (let start = 0; start < rows.length; start += SEED_BATCH) {
		const records = rows.slice(start, start + SEED_BATCH);
		const r = await rawOp(ctx, { operation: 'insert', database, table, records }, 120_000);
		strictEqual(
			r.status,
			200,
			`insert ${database}.${table}@${start} expected 200, got ${r.status}: ${r.text.slice(0, 300)}`
		);
	}
}

/**
 * Write fat rows into `table` until its database's shared log rotates at least once, so the
 * already-seeded protected entries end up in a sealed file. Bounded by the log's own configured
 * file size rather than a hardcoded byte count, which would go vacuous (or hang) if the rocksdb-js
 * rotation default moved.
 */
async function churnUntilRotation(
	ctx: ContextWithHarper,
	database: string,
	table: string
): Promise<{ rows: number; batches: number; bytes: number }> {
	const before = logOf(await topology(ctx), database, table);
	const maxFileSize = before.maxFileSize > 0 ? before.maxFileSize : DEFAULT_MAX_FILE_SIZE;
	const batchCap = Math.ceil((maxFileSize * 3) / CHURN_BATCH_BYTES) + 8;
	let rows = 0;
	for (let batch = 0; batch < batchCap; batch++) {
		const records = Array.from({ length: CHURN_BATCH }, (_, i) => ({
			id: `churn-${rows + i}`,
			bucket: 'CHURN',
			seq: rows + i,
			payload: CHURN_PAYLOAD,
		}));
		const r = await rawOp(ctx, { operation: 'insert', database, table, records }, 120_000);
		strictEqual(
			r.status,
			200,
			`churn insert ${database}.${table}@${rows} expected 200, got ${r.status}: ${r.text.slice(0, 300)}`
		);
		rows += CHURN_BATCH;
		const after = logOf(await topology(ctx), database, table);
		if (after.rotations > before.rotations) return { rows, batches: batch + 1, bytes: rows * CHURN_PAYLOAD.length };
	}
	// Rotation is observed asynchronously, so exhausting the write budget is not yet a failure —
	// give the already-written bytes a bounded window to show up as a rotation before calling it one.
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		await sleep(250);
		const after = logOf(await topology(ctx), database, table);
		if (after.rotations > before.rotations) return { rows, batches: batchCap, bytes: rows * CHURN_PAYLOAD.length };
	}
	throw new Error(
		`QA-816: ${database} transaction log never rotated after ${rows} churn rows (${(rows * CHURN_PAYLOAD.length) / 1024 / 1024}MiB, maxFileSize=${maxFileSize})`
	);
}

async function idsWithInsertAudit(
	ctx: ContextWithHarper,
	database: string,
	table: string,
	ids: string[],
	before?: number
): Promise<string[]> {
	const r = await rawOp(
		ctx,
		{ operation: 'read_audit_log', database, table, search_type: 'hash_value', search_values: ids },
		120_000
	);
	strictEqual(
		r.status,
		200,
		`read_audit_log ${database}.${table} expected 200, got ${r.status}: ${r.text.slice(0, 300)}`
	);
	return ids.filter((id) => {
		const entries = Array.isArray(r.body?.[id]) ? r.body[id] : [];
		return entries.some((entry: any) => {
			if (entry?.operation !== 'insert') return false;
			if (before === undefined) return true;
			const timestamp = Number(entry.timestamp);
			return Number.isFinite(timestamp) && timestamp < before;
		});
	});
}

function assertRowSetMatches(label: string, surface: string, expected: SeededRow[], actual: any[]): void {
	const byId = new Map<string, any>();
	for (const record of actual) {
		ok(!byId.has(record.id), `[${label}] ${surface} returned duplicate id ${record.id}`);
		byId.set(record.id, record);
	}
	strictEqual(
		byId.size,
		expected.length,
		`[${label}] ${surface} must return exactly ${expected.length} rows, got ${byId.size}`
	);
	for (const row of expected) {
		const record = byId.get(row.id);
		ok(record, `[${label}] ${surface} lost row ${row.id}`);
		deepStrictEqual(
			{ id: record.id, bucket: record.bucket, seq: record.seq, payload: record.payload },
			row,
			`[${label}] ${surface} returned a modified row for ${row.id}`
		);
	}
}

async function restCollection(ctx: ContextWithHarper, table: string, bucket: string): Promise<any[]> {
	const r = await restJson(ctx, `/${table}/?bucket=${bucket}`);
	strictEqual(r.status, 200, `REST /${table}/?bucket=${bucket} expected 200, got ${r.status}`);
	ok(
		Array.isArray(r.body),
		`REST /${table}/?bucket=${bucket} must return an array, got ${JSON.stringify(r.body)?.slice(0, 200)}`
	);
	return r.body;
}

async function searchByBucket(ctx: ContextWithHarper, database: string, table: string, bucket: string): Promise<any[]> {
	const r = await rawOp(
		ctx,
		{
			operation: 'search_by_value',
			database,
			table,
			search_attribute: 'bucket',
			search_value: bucket,
			get_attributes: ['id', 'bucket', 'seq', 'payload'],
		},
		120_000
	);
	strictEqual(
		r.status,
		200,
		`search_by_value(${database}.${table}) expected 200, got ${r.status}: ${r.text.slice(0, 300)}`
	);
	ok(Array.isArray(r.body), `search_by_value(${database}.${table}) must return an array`);
	return r.body;
}

async function fullScan(
	ctx: ContextWithHarper,
	database: string,
	table: string,
	mode: 'count' | 'records'
): Promise<{ totalCount: number; records: any[] }> {
	const r = await restJson(ctx, `/FullScan/?database=${database}&table=${table}&mode=${mode}`);
	strictEqual(
		r.status,
		200,
		`/FullScan/ ${database}.${table} expected 200, got ${r.status}: ${JSON.stringify(r.body)?.slice(0, 200)}`
	);
	return r.body;
}

suite(
	'QA-816 purge blast radius: audit-durability-only, never primary data [rocksdb]',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		const findings: string[] = [];
		const armConfig = {
			threads: { count: 1 },
			logging: { auditLog: true, console: true, level: 'error' },
			storage: { engine: 'rocksdb' },
		};
		let churnRows = 0;
		let remoteChurnRows = 0;
		let cutoffTimestamp = Number.NaN;
		let armed = false;
		let quietAuditBefore = 0;
		let ledgerAuditBefore = 0;

		function assertArmed(): void {
			ok(armed, 'PRECONDITION: the seed/arm phase must complete before the purge, read, or restart probes run');
		}

		/**
		 * The headline check. Every protected primary row in BOTH databases, value-exact, on three
		 * independent read surfaces plus a point-read sample — and the churn tables' rows counted, so a
		 * purge that ate primary data in bulk cannot hide behind the protected tables.
		 */
		async function assertPrimaryIntact(label: string): Promise<void> {
			assertRowSetMatches(label, 'REST collection', LEDGER_ROWS, await restCollection(ctx, 'Ledger', 'LEDGER'));
			assertRowSetMatches(
				label,
				'search_by_value',
				LEDGER_ROWS,
				await searchByBucket(ctx, PURGED_DB, 'Ledger', 'LEDGER')
			);
			const ledgerScan = await fullScan(ctx, PURGED_DB, 'Ledger', 'records');
			assertRowSetMatches(label, 'full primary-store scan', LEDGER_ROWS, ledgerScan.records);
			strictEqual(
				ledgerScan.totalCount,
				LEDGER_COUNT,
				`[${label}] full scan of ${PURGED_DB}.Ledger must total ${LEDGER_COUNT}`
			);

			for (const id of LEDGER_SAMPLE_IDS) {
				const r = await restJson(ctx, `/Ledger/${id}`);
				strictEqual(r.status, 200, `[${label}] REST GET /Ledger/${id} expected 200, got ${r.status}`);
				const expected = LEDGER_ROWS.find((row) => row.id === id);
				deepStrictEqual(
					{ id: r.body?.id, bucket: r.body?.bucket, seq: r.body?.seq, payload: r.body?.payload },
					expected,
					`[${label}] REST GET /Ledger/${id} returned a modified row`
				);
			}

			assertRowSetMatches(label, 'REST collection', QUIET_ROWS, await restCollection(ctx, 'QuietLedger', 'QUIET'));
			assertRowSetMatches(
				label,
				'search_by_value',
				QUIET_ROWS,
				await searchByBucket(ctx, PURGED_DB, 'QuietLedger', 'QUIET')
			);
			assertRowSetMatches(
				label,
				'full primary-store scan',
				QUIET_ROWS,
				(await fullScan(ctx, PURGED_DB, 'QuietLedger', 'records')).records
			);

			assertRowSetMatches(label, 'REST collection', REMOTE_ROWS, await restCollection(ctx, 'RemoteLedger', 'REMOTE'));
			assertRowSetMatches(
				label,
				'search_by_value',
				REMOTE_ROWS,
				await searchByBucket(ctx, CONTROL_DB, 'RemoteLedger', 'REMOTE')
			);
			assertRowSetMatches(
				label,
				'full primary-store scan',
				REMOTE_ROWS,
				(await fullScan(ctx, CONTROL_DB, 'RemoteLedger', 'records')).records
			);

			strictEqual(
				(await fullScan(ctx, PURGED_DB, 'Churn', 'count')).totalCount,
				churnRows,
				`[${label}] ${PURGED_DB}.Churn must still hold all ${churnRows} churn rows`
			);
			strictEqual(
				(await fullScan(ctx, CONTROL_DB, 'RemoteChurn', 'count')).totalCount,
				remoteChurnRows,
				`[${label}] ${CONTROL_DB}.RemoteChurn must still hold all ${remoteChurnRows} churn rows`
			);
			findings.push(
				`[${label}] primary intact: Ledger ${LEDGER_COUNT}/${LEDGER_COUNT}, QuietLedger ${QUIET_COUNT}/${QUIET_COUNT}, ` +
					`RemoteLedger ${REMOTE_COUNT}/${REMOTE_COUNT}, Churn ${churnRows}, RemoteChurn ${remoteChurnRows}`
			);
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: armConfig, env: { HARPER_STORAGE_ENGINE: 'rocksdb' } });
			await pollReadiness(ctx);
		});

		after(async () => {
			try {
				await teardownHarper(ctx);
			} finally {
				// eslint-disable-next-line no-console
				console.log(`\n=== QA-816 findings ===\n${findings.map((f) => '  ' + f).join('\n')}\n`);
			}
		});

		test('0. precondition: one native transaction log per database, shared by its tables', async () => {
			const topo = await topology(ctx);
			for (const [key, entry] of Object.entries(topo)) {
				strictEqual(entry.engineGuess, 'rocksdb', `PRECONDITION: ${key} must be on RocksDB, got ${entry.engineGuess}`);
			}

			const lookup = (database: string, table: string): TableTopology => {
				const entry = topo[`${database}.${table}`];
				ok(entry, `PRECONDITION: ${database}.${table} is missing from the topology: ${Object.keys(topo).join(', ')}`);
				return entry;
			};
			const purged = [lookup(PURGED_DB, 'Ledger'), lookup(PURGED_DB, 'QuietLedger'), lookup(PURGED_DB, 'Churn')];
			const control = [lookup(CONTROL_DB, 'RemoteLedger'), lookup(CONTROL_DB, 'RemoteChurn')];
			for (const group of [purged, control]) {
				for (const entry of group.slice(1)) {
					strictEqual(
						entry.auditStoreId,
						group[0].auditStoreId,
						`PRECONDITION: ${entry.database}.${entry.table} must share ${group[0].table}'s audit store`
					);
					strictEqual(
						entry.logId,
						group[0].logId,
						`PRECONDITION: ${entry.database}.${entry.table} must share ${group[0].table}'s native transaction log`
					);
				}
			}
			ok(
				purged[0].logId !== control[0].logId,
				`PRECONDITION: ${PURGED_DB} and ${CONTROL_DB} must not share a transaction log (both logId=${purged[0].logId})`
			);
			findings.push(
				`0. ${PURGED_DB} log=${purged[0].log?.path} (shared by ${purged.length} tables); ` +
					`${CONTROL_DB} log=${control[0].log?.path} (shared by ${control.length} tables); ` +
					`maxFileSize=${purged[0].log?.maxFileSize}`
			);
		});

		test(
			'1. seed the protected rows and prove their audit history is there to lose',
			{ timeout: 300_000 },
			async () => {
				await insertRows(ctx, PURGED_DB, 'Ledger', LEDGER_ROWS);
				await insertRows(ctx, PURGED_DB, 'QuietLedger', QUIET_ROWS);
				await insertRows(ctx, CONTROL_DB, 'RemoteLedger', REMOTE_ROWS);

				quietAuditBefore = (
					await idsWithInsertAudit(
						ctx,
						PURGED_DB,
						'QuietLedger',
						QUIET_ROWS.map((r) => r.id)
					)
				).length;
				ledgerAuditBefore = (await idsWithInsertAudit(ctx, PURGED_DB, 'Ledger', LEDGER_AUDIT_SAMPLE_IDS)).length;
				const remoteAuditBefore = (
					await idsWithInsertAudit(
						ctx,
						CONTROL_DB,
						'RemoteLedger',
						REMOTE_ROWS.map((r) => r.id)
					)
				).length;

				findings.push(
					`1. pre-purge audit: QuietLedger ${quietAuditBefore}/${QUIET_COUNT}, ` +
						`Ledger sample ${ledgerAuditBefore}/${LEDGER_AUDIT_SAMPLE_IDS.length}, RemoteLedger ${remoteAuditBefore}/${REMOTE_COUNT}`
				);
				strictEqual(
					quietAuditBefore,
					QUIET_COUNT,
					'ORACLE ARMING: every QuietLedger row must have audit history before the purge'
				);
				strictEqual(
					ledgerAuditBefore,
					LEDGER_AUDIT_SAMPLE_IDS.length,
					'ORACLE ARMING: every sampled Ledger row must have audit history before the purge'
				);
				strictEqual(
					remoteAuditBefore,
					REMOTE_COUNT,
					'ORACLE ARMING: every RemoteLedger row must have audit history before the purge'
				);
			}
		);

		test(
			'2. arm both logs: churn each database past a rotation, flush, then take the cutoff',
			{ timeout: 900_000 },
			async () => {
				const purgedChurn = await churnUntilRotation(ctx, PURGED_DB, 'Churn');
				churnRows = purgedChurn.rows;
				const controlChurn = await churnUntilRotation(ctx, CONTROL_DB, 'RemoteChurn');
				remoteChurnRows = controlChurn.rows;

				for (const [database, table] of [
					[PURGED_DB, 'Ledger'],
					[CONTROL_DB, 'RemoteLedger'],
				] as const) {
					const log = await flushUntilPurgeable(ctx, database, table);
					findings.push(
						`2. ${database} log armed: files=${log.fileCount} oldestSeq=${log.oldestSequenceNumber} ` +
							`currentSeq=${log.currentSequenceNumber} lastFlushedSeq=${log.lastFlushedSequence} rotations=${log.rotations}`
					);
				}

				cutoffTimestamp = Date.now();
				await sleep(250);
				armed = true;
				findings.push(
					`2. churn: ${PURGED_DB}.Churn ${churnRows} rows / ${purgedChurn.batches} batches, ` +
						`${CONTROL_DB}.RemoteChurn ${remoteChurnRows} rows / ${controlChurn.batches} batches; cutoff=${cutoffTimestamp}`
				);
			}
		);

		test(`3. purge ${PURGED_DB} and prove the purge was real`, { timeout: 180_000 }, async () => {
			assertArmed();
			const ack = await rawOp(ctx, {
				operation: 'delete_transaction_logs_before',
				database: PURGED_DB,
				timestamp: cutoffTimestamp,
			});
			strictEqual(
				ack.status,
				200,
				`delete_transaction_logs_before expected 200, got ${ack.status}: ${ack.text.slice(0, 300)}`
			);
			ok(ack.body?.job_id, `delete_transaction_logs_before must return a job_id, got ${ack.text.slice(0, 300)}`);

			const job = await pollJob(ctx, ack.body.job_id);
			findings.push(
				`3. purge job: status=${job.status} result=${JSON.stringify(job.result)} message=${job.message ?? ''}`
			);
			strictEqual(job.status, 'COMPLETE', `purge job must COMPLETE, got ${job.status}: ${job.message}`);
			ok(
				job.result && typeof job.result === 'object',
				`purge job must carry a result object, got ${JSON.stringify(job.result)}`
			);
			ok(
				Number(job.result.entries_deleted) > 0,
				`NON-VACUOUS PRECONDITION: the purge must delete audit entries, got entries_deleted=${job.result.entries_deleted}`
			);
			ok(
				Number(job.result.log_files_deleted) > 0,
				`NON-VACUOUS PRECONDITION: the purge must delete log files, got log_files_deleted=${job.result.log_files_deleted}`
			);
		});

		test('4. KEY TEST (same process): every primary row survives the purge', { timeout: 300_000 }, async () => {
			assertArmed();
			await assertPrimaryIntact('4. POST-PURGE same process');
		});

		test(
			'5. restart #1: primary rows survive, and the audit loss is confined to the purged database',
			{ timeout: 300_000 },
			async () => {
				assertArmed();
				await killHarper(ctx as any);
				await startHarper(ctx, { config: armConfig, env: { HARPER_STORAGE_ENGINE: 'rocksdb' } });
				await pollReadiness(ctx);

				await assertPrimaryIntact('5. POST-RESTART-1');

				// Measured after a restart on purpose: an in-process transaction-log read cache can keep
				// serving purged audit entries until the process restarts (rocksdb-js#808), so a
				// same-process audit read is not authoritative about what is actually on disk.
				const remoteAfter = (
					await idsWithInsertAudit(
						ctx,
						CONTROL_DB,
						'RemoteLedger',
						REMOTE_ROWS.map((r) => r.id),
						cutoffTimestamp
					)
				).length;
				const ledgerAfter = (
					await idsWithInsertAudit(ctx, PURGED_DB, 'Ledger', LEDGER_AUDIT_SAMPLE_IDS, cutoffTimestamp)
				).length;
				const quietAfter = (
					await idsWithInsertAudit(
						ctx,
						PURGED_DB,
						'QuietLedger',
						QUIET_ROWS.map((r) => r.id),
						cutoffTimestamp
					)
				).length;
				findings.push(
					`5. post-restart audit: RemoteLedger ${remoteAfter}/${REMOTE_COUNT} (control, must be whole), ` +
						`Ledger sample ${ledgerAfter}/${ledgerAuditBefore}, QuietLedger ${quietAfter}/${quietAuditBefore} ` +
						`(quiet same-database sibling — reported, not asserted)`
				);

				strictEqual(
					remoteAfter,
					REMOTE_COUNT,
					`BLAST-RADIUS INVARIANT: a ${PURGED_DB}-scoped purge must not remove any ${CONTROL_DB} audit entry, got ${remoteAfter}/${REMOTE_COUNT}`
				);
				ok(
					ledgerAfter < ledgerAuditBefore,
					`NON-VACUOUS PRECONDITION: the purge must have removed audit history from ${PURGED_DB}, but the Ledger sample still holds ${ledgerAfter}/${ledgerAuditBefore} pre-cutoff entries`
				);
			}
		);

		test('6. restart #2: primary rows still survive a second clean restart', { timeout: 300_000 }, async () => {
			assertArmed();
			await killHarper(ctx as any);
			await startHarper(ctx, { config: armConfig, env: { HARPER_STORAGE_ENGINE: 'rocksdb' } });
			await pollReadiness(ctx);
			await assertPrimaryIntact('6. POST-RESTART-2');
		});
	}
);
