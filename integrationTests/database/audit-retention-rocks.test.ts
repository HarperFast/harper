import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'audit-retention-lmdb');
const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

function authHeader(ctx: ContextWithHarper): string {
	const { username, password } = ctx.harper.admin;
	return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function getStats(ctx: ContextWithHarper): Promise<any> {
	const response = await fetch(`${ctx.harper.httpURL}/TransactionLogStats/`, {
		headers: { Authorization: authHeader(ctx) },
	});
	ok(response.ok, `TransactionLogStats failed with ${response.status}`);
	return response.json();
}

async function waitForStats(ctx: ContextWithHarper): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			if (await getStats(ctx)) return;
		} catch {}
		await sleep(250);
	}
	throw new Error('TransactionLogStats did not become ready');
}

async function waitForPurgeRun(ctx: ContextWithHarper, previousRuns: number): Promise<number> {
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		try {
			const runs = (await getStats(ctx))?.totals?.purgeRuns;
			if (typeof runs === 'number' && runs > previousRuns) return runs;
		} catch {}
		await sleep(250);
	}
	throw new Error(`RocksDB transaction-log cleanup did not advance past purgeRuns=${previousRuns}`);
}

suite(
	'RocksDB audit retention self-rearms without storage pressure (#2140)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: 1 },
					logging: { auditLog: true, auditRetention: 2 },
				},
				env: {
					HARPER_STORAGE_ENGINE: 'rocksdb',
					STORAGE_RECLAMATION_THRESHOLD: 0,
				},
			});
			await waitForStats(ctx);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		test('runs more than one passive purge pass', { timeout: 90_000 }, async () => {
			const engineResponse = await fetch(`${ctx.harper.httpURL}/StorageEngineInfo/`, {
				headers: { Authorization: authHeader(ctx) },
			});
			const engine = await engineResponse.json();
			strictEqual(engine.engineGuess, 'rocksdb');

			await sendOperation(ctx.harper, {
				operation: 'insert',
				schema: 'data',
				table: 'Ledger',
				records: [{ id: 'first-pass', seq: 1, payload: 'first-pass' }],
			});
			const initialRuns = (await getStats(ctx))?.totals?.purgeRuns ?? 0;
			const firstRun = await waitForPurgeRun(ctx, initialRuns);

			await sendOperation(ctx.harper, {
				operation: 'insert',
				schema: 'data',
				table: 'Ledger',
				records: [{ id: 'second-pass', seq: 2, payload: 'second-pass' }],
			});
			const secondRun = await waitForPurgeRun(ctx, firstRun);
			ok(secondRun > firstRun, `expected a re-armed purge pass after ${firstRun}, got ${secondRun}`);
		});
	}
);
