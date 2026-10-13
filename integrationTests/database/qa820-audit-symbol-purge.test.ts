/** QA-820 / P-573: LMDB table-scoped public purge must leave symbol-key metadata unread
 * (https://github.com/HarperFast/harper/pull/2472). With start: 0, deleteHistory can skip the
 * misdecoded marker and still report one deletion, so captured logs are the regression oracle.
 * The warning latches once per worker; every public job starts a fresh worker.
 * requires-isolation: QA promotion gate marker.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const fixture = resolve(import.meta.dirname, 'qa820-audit-symbol-purge');
// Match neighboring purge suites; Windows remains skipped while harper#2401 tracks process death.
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

function auth(ctx: ContextWithHarper) {
	const { username, password } = ctx.harper.admin;
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function operation(ctx: ContextWithHarper, body: any) {
	const response = await fetch(ctx.harper.operationsAPIURL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': auth(ctx) },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});
	const raw = await response.text();
	assert.strictEqual(response.status, 200, `${body.operation}: HTTP ${response.status}: ${raw}`);
	return JSON.parse(raw);
}

async function snapshot(ctx: ContextWithHarper, decodeMarker = false) {
	const url = new URL('/Snapshot/', ctx.harper.httpURL);
	if (decodeMarker) url.searchParams.set('decodeMarker', 'true');
	const response = await fetch(url, {
		headers: { Authorization: auth(ctx) },
		signal: AbortSignal.timeout(20_000),
	});
	const raw = await response.text();
	assert.strictEqual(response.status, 200, `Snapshot: HTTP ${response.status}: ${raw}`);
	return JSON.parse(raw);
}

async function poll<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
	const deadline = Date.now() + 30_000;
	let last: T;
	do {
		last = await read();
		if (ready(last)) return last;
		await sleep(30);
	} while (Date.now() < deadline);
	throw new Error(`${label}: timed out, last=${JSON.stringify(last)}`);
}

async function purge(ctx: ContextWithHarper, cutoff: number) {
	const ack = await operation(ctx, {
		operation: 'delete_transaction_logs_before',
		schema: 'data',
		table: 'Purge820',
		timestamp: cutoff,
	});
	assert.ok(typeof ack.job_id === 'string', `missing job_id: ${JSON.stringify(ack)}`);
	const response = await poll(
		() => operation(ctx, { operation: 'get_job', id: ack.job_id }),
		(value: any) => ['COMPLETE', 'ERROR'].includes((Array.isArray(value) ? value[0] : value)?.status),
		`purge job ${ack.job_id}`
	);
	const job = Array.isArray(response) ? response[0] : response;
	assert.strictEqual(job.status, 'COMPLETE', `purge job failed: ${JSON.stringify(job)}`);
	assert.ok(Number.isInteger(job.result?.entries_deleted), `missing entries_deleted: ${JSON.stringify(job)}`);
	return { jobId: ack.job_id, entriesDeleted: job.result.entries_deleted };
}

function readLogs(directory: string): string {
	return readdirSync(directory, { withFileTypes: true })
		.map((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return readLogs(path);
			return entry.isFile() && entry.name.endsWith('.log') ? readFileSync(path, 'utf8') : '';
		})
		.join('\n');
}

function classifyLogs(logs: string) {
	return {
		auditEntryErrors: (logs.match(/Reading audit entry error/g) || []).length,
		corruptHeaders: (logs.match(/Audit entry header begins with neither an action nor a previousVersion/g) || [])
			.length,
	};
}

suite('QA-820 LMDB public purge skips symbol metadata', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, fixture, {
			config: { storage: { engine: 'lmdb' }, threads: { count: 1 }, logging: { auditLog: true } },
			env: { HARPER_STORAGE_ENGINE: 'lmdb' },
		});
		await poll(
			() => snapshot(ctx).catch(() => null),
			(value: any) => value?.tableId != null,
			'GET Snapshot readiness'
		);
	});
	after(async () => {
		await teardownHarper(ctx);
	});

	test('twelve serial jobs remove entries without purge diagnostics', { timeout: 180_000 }, async () => {
		const baseline = await snapshot(ctx);
		assert.match(baseline.enginePath, /\.mdb$/, 'LMDB engine must be active');
		assert.strictEqual(baseline.markerByteLength, 8, 'last-removed marker must exist as eight raw bytes');
		assert.strictEqual(baseline.entries.length, 0, 'new table must start without audit entries');
		const logDir = ctx.harper.logDir ?? join(ctx.harper.dataRootDir, 'log');
		const initialLogCounts = classifyLogs(readLogs(logDir));
		for (let round = 1; round <= 12; round++) {
			const id = `qa820-${round}`;
			await operation(ctx, { operation: 'insert', schema: 'data', table: 'Purge820', records: [{ id, seq: round }] });
			const seeded = await poll(
				() => snapshot(ctx),
				(value: any) => value.entries.some((entry: any) => entry.recordId === id),
				`raw audit entry for ${id}`
			);
			const matching = seeded.entries.filter(
				(entry: any) => entry.recordId === id && entry.tableId === baseline.tableId
			);
			assert.strictEqual(matching.length, 1, `round ${round}: one persisted entry required`);
			const entry = matching[0];
			assert.ok(Number.isFinite(entry.key) && entry.key > 1, `round ${round}: invalid raw audit key ${entry.key}`);
			assert.strictEqual(seeded.markerByteLength, 8, `round ${round}: marker disappeared`);
			const beforePurge = classifyLogs(readLogs(logDir));
			assert.strictEqual(
				beforePurge.auditEntryErrors,
				initialLogCounts.auditEntryErrors,
				`round ${round}: setup emitted audit entry decoder errors before the purge`
			);
			assert.strictEqual(
				beforePurge.corruptHeaders,
				initialLogCounts.corruptHeaders,
				`round ${round}: setup emitted corrupt-header warnings before the purge`
			);
			const result = await purge(ctx, entry.key + 1);
			const afterPurgeLogs = readLogs(logDir);
			const afterPurge = classifyLogs(afterPurgeLogs);
			assert.ok(
				afterPurgeLogs.includes(`Successfully completed job: ${result.jobId}`),
				`round ${round}: job worker log was not captured for ${result.jobId}`
			);
			assert.strictEqual(result.entriesDeleted, 1, `round ${round}: job did not report one deletion`);
			assert.strictEqual(
				afterPurge.auditEntryErrors,
				beforePurge.auditEntryErrors,
				`round ${round}: purge emitted audit entry decoder errors`
			);
			assert.strictEqual(
				afterPurge.corruptHeaders,
				beforePurge.corruptHeaders,
				`round ${round}: purge emitted corrupt-header warnings`
			);
			const afterState = await snapshot(ctx);
			assert.strictEqual(
				afterState.entries.some((row: any) => row.key === entry.key),
				false,
				`round ${round}: raw key survived`
			);
			assert.strictEqual(afterState.entries.length, 0, `round ${round}: unexpected audit entries remain`);
			assert.strictEqual(afterState.markerByteLength, 8, `round ${round}: marker missing after purge`);
		}

		const finalLogs = readLogs(logDir);
		const classified = classifyLogs(finalLogs);
		assert.strictEqual(
			classified.auditEntryErrors,
			initialLogCounts.auditEntryErrors,
			'test run added audit entry decoder errors outside the per-purge checks'
		);
		assert.strictEqual(
			classified.corruptHeaders,
			initialLogCounts.corruptHeaders,
			'test run added corrupt-header warnings outside the per-purge checks'
		);

		const beforeControl = classified;
		const control = await snapshot(ctx, true);
		assert.strictEqual(control.decodeMarker, true, 'decoded-marker positive control did not run');
		const controlledLogs = await poll(
			async () => readLogs(logDir),
			(logs) => {
				const counts = classifyLogs(logs);
				return (
					counts.auditEntryErrors + counts.corruptHeaders >=
					beforeControl.auditEntryErrors + beforeControl.corruptHeaders + 1
				);
			},
			'decoded-marker positive control diagnostic'
		);
		const controlBaseline = classifyLogs(controlledLogs);
		const controlErrors = controlBaseline.auditEntryErrors - beforeControl.auditEntryErrors;
		const controlWarnings = controlBaseline.corruptHeaders - beforeControl.corruptHeaders;
		assert.strictEqual(
			controlErrors + controlWarnings,
			1,
			`decoded-marker control must emit exactly one classified diagnostic: ${JSON.stringify({ controlErrors, controlWarnings })}`
		);
	});
});
