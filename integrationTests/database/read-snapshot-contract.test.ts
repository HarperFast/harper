/**
 * QA-185 — Within-request read-snapshot contract.
 *
 * Pins that a SINGLE Harper response presents a self-consistent snapshot across four read
 * surfaces — REST collection GET, GraphQL query, ops search_by_value, SQL SELECT — while
 * concurrent writers mutate the same data mid-request.
 *
 *   (a) SINGLE-RESPONSE SELF-CONSISTENCY (Q1–Q3): while one client inserts and deletes rows
 *       within one transaction, every REST / GraphQL / search_by_value response must contain
 *       exactly the seeded rows (val=1) — never a row of that uncommitted transaction.
 *
 *   (b) SNAPSHOT STABILITY (Q4 SQL SELECT, Q5 long scan): while a concurrent request overwrites
 *       a whole bucket in one transaction, each response must hold one snapshot — all-original
 *       or all-overwrite values, never a mix.
 *
 * RUNS: default RocksDB (single-worker), LMDB (single-worker).
 *
 * Harper SHA: 7aaa5a152
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/read-snapshot-contract.test.ts"
 *   HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "integrationTests/database/read-snapshot-contract.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations
import { createApiClient } from './../apiTests/utils/client.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const FIXTURE_PATH = resolve(import.meta.dirname, 'read-snapshot-contract');
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
const WORKER_COUNT = Number(process.env.HARPER_WORKER_COUNT) || 1;

// Seeded value for Q1-Q4 / Q5 stability test
const SEED_VALUE_AB = 1; // Ledger rows in bucket Q185A
const SEED_VALUE_B = 42; // Ledger rows in bucket Q185B (long-scan test)
const OVERWRITE_VALUE = 99; // value used in the concurrent overwrite (Q5)

const LEDGER_A_COUNT = 50;

const N_ACCOUNTS = 8;
const EACH_BALANCE = 1000;
const TOTAL_INV = N_ACCOUNTS * EACH_BALANCE; // 8000

type ApiClient = ReturnType<typeof createApiClient>;

suite(
	`QA-185 within-request read-snapshot [${ENGINE} workers=${WORKER_COUNT}]`,
	{
		skip: process.platform === 'win32',
	},
	(ctx: ContextWithHarper) => {
		let client: ApiClient;
		let httpURL: string;
		let authHeader: string;
		let opsURL: string;

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					threads: { count: WORKER_COUNT },
					logging: { console: true, level: 'error' },
				},
				env: {},
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			authHeader = client.headers.Authorization;
			opsURL = ctx.harper.operationsAPIURL;

			// Poll for route readiness (component is pre-installed; no restart needed)
			{
				const deadline = Date.now() + 120_000;
				while (Date.now() < deadline) {
					try {
						const probe = await client.reqRest('/Probe/').timeout(2000);
						if (probe.status !== 404) break;
					} catch {
						/* not ready yet */
					}
					await sleep(250);
				}
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ---- helpers -----------------------------------------------------------------

		function postJSON(path: string, body: unknown): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify(body),
			});
		}

		function getJSON(path: string): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				headers: { Authorization: authHeader },
			});
		}

		async function opsPost(body: unknown): Promise<Response> {
			return fetch(opsURL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': authHeader,
				},
				body: JSON.stringify(body),
			});
		}

		// ---- Q0: Seed and readiness --------------------------------------------------

		test('Q0 seed and readiness', { timeout: 60_000 }, async () => {
			const r1 = await postJSON('/SeedLedger/', { bucket: 'Q185A', count: LEDGER_A_COUNT, val: SEED_VALUE_AB });
			strictEqual(r1.status, 200, 'SeedLedger Q185A should succeed');

			// Seed 8 accounts with balance=1000 each (invariant = 8000)
			const r2 = await postJSON('/SeedAccount/', { n: N_ACCOUNTS, each: EACH_BALANCE });
			strictEqual(r2.status, 200, 'SeedAccount should succeed');

			const rSnap = await getJSON('/LedgerSnap/?bucket=Q185A');
			strictEqual(rSnap.status, 200, 'LedgerSnap Q185A should succeed');
			const snap = (await rSnap.json()) as { bucket: string; count: number; vals: number[] };
			strictEqual(snap.count, LEDGER_A_COUNT, `pre-test Q185A count should be ${LEDGER_A_COUNT}, got ${snap.count}`);
			const allCorrect = snap.vals.every((v) => v === SEED_VALUE_AB);
			ok(
				allCorrect,
				`pre-test: all vals should be ${SEED_VALUE_AB}, got anomalies: ${snap.vals
					.filter((v) => v !== SEED_VALUE_AB)
					.slice(0, 5)
					.join(',')}`
			);

			// Verify AccountScan returns sum=8000
			const rSum = await getJSON('/AccountScan/');
			strictEqual(rSum.status, 200, 'AccountScan should succeed');
			const sumBody = (await rSum.json()) as { sum: number; n: number };
			strictEqual(sumBody.sum, TOTAL_INV, `initial account sum should be ${TOTAL_INV}, got ${sumBody.sum}`);
			strictEqual(sumBody.n, N_ACCOUNTS, `initial account count should be ${N_ACCOUNTS}, got ${sumBody.n}`);

			console.log(
				`[QA-185 Q0 ${ENGINE} w=${WORKER_COUNT}] seed OK: ${LEDGER_A_COUNT} ledger rows (value=${SEED_VALUE_AB}), ${N_ACCOUNTS} accounts (sum=${TOTAL_INV})`
			);
		});

		// ---- Q1–Q3: single-response self-consistency under insert+delete churn ---------
		//
		// LedgerMutate inserts and then deletes its own val=99 rows within ONE request transaction,
		// so no committed snapshot ever contains them. Every response must therefore show exactly the
		// seeded Q185A population; a mutate row in a response is a read of uncommitted state.

		async function withLedgerChurn(read: () => Promise<void>): Promise<{ reads: number; writes: number }> {
			let stopWriter = false;
			let writes = 0;
			const writerStatuses = new Set<number>();
			// Settles to the writer's error (or undefined) so a failure is observed at once, not left unhandled.
			const writerFailure = (async () => {
				while (!stopWriter) {
					const response = await fetch(`${httpURL}/LedgerMutate/`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
						body: JSON.stringify({ bucket: 'Q185A', count: 10 }),
						signal: AbortSignal.timeout(10_000),
					});
					await response.arrayBuffer();
					writerStatuses.add(response.status);
					writes++;
				}
			})().then(
				() => undefined,
				(error: unknown) => error ?? new Error('LedgerMutate writer failed')
			);
			let reads = 0;
			let writerError: unknown;
			try {
				const deadline = Date.now() + 1_500;
				while (Date.now() < deadline) {
					await read();
					reads++;
				}
			} finally {
				stopWriter = true;
				writerError = await writerFailure;
			}
			if (writerError) throw writerError;
			ok(reads > 0, 'no read completed');
			ok(writes > 0, 'the concurrent writer never completed a request');
			strictEqual([...writerStatuses].join(','), '200', 'LedgerMutate statuses');
			return { reads, writes };
		}

		test('Q1 REST single-response self-consistency (LedgerSnap GET)', { timeout: 60_000 }, async () => {
			const { reads, writes } = await withLedgerChurn(async () => {
				const r = await getJSON('/LedgerSnap/?bucket=Q185A');
				strictEqual(r.status, 200, 'LedgerSnap status');
				const body = (await r.json()) as { count: number; vals: number[] };
				strictEqual(body.count, LEDGER_A_COUNT, `LedgerSnap row count: ${JSON.stringify(body.vals)}`);
				ok(
					body.vals.every((v) => v === SEED_VALUE_AB),
					`LedgerSnap returned a non-seeded val: ${JSON.stringify(body.vals)}`
				);
			});
			console.log(
				`[QA-185 Q1 REST ${ENGINE} w=${WORKER_COUNT}] reads=${reads} writes=${writes} — every response seeded-only`
			);
		});

		test('Q2 GraphQL single-response self-consistency', { timeout: 60_000 }, async () => {
			// Harper GraphQL: { TableName { fields } } — no limit argument; field is `val` (not `value`)
			const gqlQuery = { query: '{ Ledger { id bucket seq val } }' };
			const { reads, writes } = await withLedgerChurn(async () => {
				const r = await fetch(`${httpURL}/graphql`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
					body: JSON.stringify(gqlQuery),
				});
				const text = await r.text();
				strictEqual(r.status, 200, `GraphQL status: ${text.slice(0, 300)}`);
				const body = JSON.parse(text) as {
					data?: { Ledger?: Array<{ id: string; bucket: string; val: number }> };
					errors?: unknown[];
				};
				strictEqual(body.errors, undefined, `GraphQL errors: ${text.slice(0, 300)}`);
				const rows = (body.data?.Ledger ?? []).filter((row) => row.bucket === 'Q185A');
				strictEqual(rows.length, LEDGER_A_COUNT, `GraphQL Q185A rows: ${JSON.stringify(rows.slice(0, 5))}`);
				ok(
					rows.every((row) => row.val === SEED_VALUE_AB && !row.id.includes('-mut-')),
					`GraphQL returned a non-seeded Q185A row: ${JSON.stringify(rows.filter((row) => row.val !== SEED_VALUE_AB))}`
				);
			});
			console.log(
				`[QA-185 Q2 GraphQL ${ENGINE} w=${WORKER_COUNT}] reads=${reads} writes=${writes} — every response seeded-only`
			);
		});

		test('Q3 ops search_by_value self-consistency', { timeout: 60_000 }, async () => {
			const { reads, writes } = await withLedgerChurn(async () => {
				const r = await opsPost({
					operation: 'search_by_value',
					schema: 'data',
					table: 'Ledger',
					search_attribute: 'bucket',
					search_value: 'Q185A',
					get_attributes: ['id', 'bucket', 'seq', 'val'],
				});
				const text = await r.text();
				strictEqual(r.status, 200, `search_by_value status: ${text.slice(0, 300)}`);
				const rows = JSON.parse(text) as Array<{ id: string; val: number }>;
				ok(Array.isArray(rows), `search_by_value should return an array: ${text.slice(0, 300)}`);
				strictEqual(rows.length, LEDGER_A_COUNT, `search_by_value rows: ${JSON.stringify(rows.slice(0, 5))}`);
				ok(
					rows.every((row) => row.val === SEED_VALUE_AB && !row.id.includes('-mut-')),
					`search_by_value returned a non-seeded row: ${JSON.stringify(rows.filter((row) => row.val !== SEED_VALUE_AB))}`
				);
			});
			console.log(
				`[QA-185 Q3 ops ${ENGINE} w=${WORKER_COUNT}] reads=${reads} writes=${writes} — every response seeded-only`
			);
		});

		// ---- Q4–Q5: snapshot stability under a concurrent whole-bucket overwrite ---------
		//
		// SeedLedger rewrites every row of a bucket within ONE request transaction, so a reader that
		// holds one snapshot sees either all-original or all-overwrite values, never a mix. Whether a
		// given trial's read lands before or after the overwrite commits is up to the scheduler.

		test('Q4 SQL SELECT snapshot stability (concurrent overwrite)', { timeout: 60_000 }, async () => {
			const SQL_BUCKET = 'Q185C';
			const SQL_SEED_VAL = 5;
			const SQL_OVER_VAL = 7;
			const SQL_COUNT = 40;
			const TRIALS = 3;
			let trialsMixed = 0;

			for (let trial = 0; trial < TRIALS; trial++) {
				const seedR = await postJSON('/SeedLedger/', { bucket: SQL_BUCKET, count: SQL_COUNT, val: SQL_SEED_VAL });
				strictEqual(seedR.status, 200, `Q4 trial ${trial}: SeedLedger`);
				await seedR.arrayBuffer();

				const [writerRes, sqlRes] = await Promise.all([
					postJSON('/SeedLedger/', { bucket: SQL_BUCKET, count: SQL_COUNT, val: SQL_OVER_VAL }),
					opsPost({
						operation: 'sql',
						sql: `SELECT id, bucket, val FROM data.Ledger WHERE bucket = '${SQL_BUCKET}'`,
					}),
				]);
				await writerRes.arrayBuffer();
				const text = await sqlRes.text();
				strictEqual(writerRes.status, 200, `Q4 trial ${trial}: overwriting SeedLedger`);
				strictEqual(sqlRes.status, 200, `Q4 trial ${trial}: SQL status: ${text.slice(0, 300)}`);
				const body = JSON.parse(text) as Array<{ val: number }>;
				ok(Array.isArray(body), `Q4 trial ${trial}: SQL should return an array: ${text.slice(0, 300)}`);

				const nOrig = body.filter((r) => r.val === SQL_SEED_VAL).length;
				const nOver = body.filter((r) => r.val === SQL_OVER_VAL).length;
				console.log(
					`  [Q4 SQL ${ENGINE} trial ${trial + 1}/${TRIALS}] rows=${body.length} orig(${SQL_SEED_VAL})=${nOrig} over(${SQL_OVER_VAL})=${nOver}`
				);
				strictEqual(body.length, SQL_COUNT, `Q4 trial ${trial}: SQL row count`);
				strictEqual(nOrig + nOver, SQL_COUNT, `Q4 trial ${trial}: a val that is neither seed nor overwrite`);
				if (nOrig > 0 && nOver > 0) trialsMixed++;
			}
			strictEqual(
				trialsMixed,
				0,
				`Q4: ${trialsMixed}/${TRIALS} SQL SELECT responses mixed pre- and post-overwrite rows`
			);
		});

		test('Q5 long-scan snapshot stability (concurrent overwrite)', { timeout: 60_000 }, async () => {
			const COUNT = 80;
			const TRIALS = 3;
			let trialsMixed = 0;

			for (let trial = 0; trial < TRIALS; trial++) {
				const seedRes = await postJSON('/SeedLedger/', { bucket: 'Q185B', count: COUNT, val: SEED_VALUE_B });
				strictEqual(seedRes.status, 200, `Q5 trial ${trial}: SeedLedger`);
				await seedRes.arrayBuffer();

				const [writerRes, scanRes] = await Promise.all([
					postJSON('/SeedLedger/', { bucket: 'Q185B', count: COUNT, val: OVERWRITE_VALUE }),
					getJSON('/LedgerSnap/?bucket=Q185B'),
				]);
				await writerRes.arrayBuffer();
				strictEqual(writerRes.status, 200, `Q5 trial ${trial}: overwriting SeedLedger`);
				strictEqual(scanRes.status, 200, `Q5 trial ${trial}: LedgerSnap`);
				const scanBody = (await scanRes.json()) as { count: number; vals: number[] };

				const nOriginal = scanBody.vals.filter((v) => v === SEED_VALUE_B).length;
				const nOverwrite = scanBody.vals.filter((v) => v === OVERWRITE_VALUE).length;
				console.log(
					`  [Q5 scan ${ENGINE} trial ${trial + 1}/${TRIALS}] count=${scanBody.count} original(${SEED_VALUE_B})=${nOriginal} overwrite(${OVERWRITE_VALUE})=${nOverwrite}`
				);
				strictEqual(scanBody.count, COUNT, `Q5 trial ${trial}: LedgerSnap row count`);
				strictEqual(nOriginal + nOverwrite, COUNT, `Q5 trial ${trial}: a val that is neither seed nor overwrite`);
				if (nOriginal > 0 && nOverwrite > 0) trialsMixed++;
			}
			strictEqual(trialsMixed, 0, `Q5: ${trialsMixed}/${TRIALS} scans mixed pre- and post-overwrite rows`);
		});
	}
);
