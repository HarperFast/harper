/** QA-820 / P-573: LMDB public purge job must skip audit symbol metadata (harper#2472).
 * requires-isolation: public purge raises the database-wide audit retention floor.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const fixture = resolve(import.meta.dirname, 'qa820-audit-symbol-purge');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';
const resultsFile = process.env.QA820_RESULTS_FILE;
const results: any = {
	scenario: 'QA-820',
	sha: process.env.QA820_TEST_SHA || '765a1abc18c1a892175c710729def3a63866fb24',
	rounds: [],
};

function save() {
	if (resultsFile) writeFileSync(resultsFile, JSON.stringify(results, null, 2) + '\n');
}

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

async function snapshot(ctx: ContextWithHarper) {
	const response = await fetch(`${ctx.harper.httpURL}/Snapshot/`, {
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
		markerRangeErrors: (
			logs.match(/Reading audit entry error[^\n]*RangeError|Reading audit entry error[\s\S]{0,350}?RangeError/g) || []
		).length,
		corruptHeaders: (logs.match(/Audit entry header begins with neither an action nor a previousVersion/g) || [])
			.length,
	};
}

suite('QA-820 LMDB public purge skips symbol marker', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let stopped = false;
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
		save();
		if (!stopped) await teardownHarper(ctx);
	});

	test('twelve serial jobs remove persisted entries without marker RangeErrors', { timeout: 180_000 }, async () => {
		const baseline = await snapshot(ctx);
		assert.match(baseline.enginePath, /\.mdb$/, 'LMDB engine must be active');
		assert.strictEqual(baseline.markerByteLength, 8, 'last-removed marker must exist as eight raw bytes');
		assert.ok(baseline.markerKeyCount >= 1, 'raw symbol key range must contain marker');
		assert.strictEqual(baseline.entries.length, 0, 'new table must start without audit entries');
		results.baseline = baseline;
		const markerSample = 'Reading audit entry error RangeError: Offset is outside the bounds of the DataView';
		const corruptionSample = 'Audit entry header begins with neither an action nor a previousVersion';
		assert.strictEqual(classifyLogs(markerSample).markerRangeErrors, 1);
		assert.strictEqual(classifyLogs(corruptionSample).markerRangeErrors, 0);
		assert.strictEqual(classifyLogs(corruptionSample).corruptHeaders, 1);
		for (let round = 1; round <= 12; round++) {
			const id = `qa820-${round}`;
			const measurement: any = { round, id };
			results.rounds.push(measurement);
			try {
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
				measurement.rawKey = entry.key;
				measurement.cutoff = entry.key + 1;
				measurement.beforeCount = seeded.entries.length;
				measurement.purge = await purge(ctx, measurement.cutoff);
				const afterState = await snapshot(ctx);
				measurement.afterCount = afterState.entries.length;
				measurement.remainingKeys = afterState.entries.map((row: any) => row.key);
				measurement.markerByteLengthAfter = afterState.markerByteLength;
				assert.strictEqual(measurement.purge.entriesDeleted, 1, `round ${round}: job did not report one deletion`);
				assert.strictEqual(
					afterState.entries.some((row: any) => row.key === entry.key),
					false,
					`round ${round}: raw key survived`
				);
				assert.strictEqual(afterState.entries.length, 0, `round ${round}: unexpected audit entries remain`);
				assert.strictEqual(afterState.markerByteLength, 8, `round ${round}: marker missing after purge`);
				measurement.status = 'passed';
				save();
			} catch (error) {
				measurement.status = 'failed';
				measurement.error = String((error as Error).stack || error);
				save();
				throw error;
			}
		}
		await teardownHarper(ctx);
		stopped = true;
		const logs = readLogs(ctx.harper.logDir!);
		const classified = classifyLogs(logs);
		results.logOracle = { ...classified, logDir: ctx.harper.logDir, bytes: logs.length };
		save();
		assert.ok(logs.length > 0, 'server log oracle must inspect nonempty captured logs');
		assert.strictEqual(classified.markerRangeErrors, 0, 'purge decoded the symbol marker and logged RangeError');
		assert.strictEqual(classified.corruptHeaders, 0, 'real corrupt audit headers appeared');
		console.log(
			`QA-820: ${results.rounds.length} jobs, 12 entries_deleted, ${classified.markerRangeErrors} marker RangeErrors`
		);
	});
});
