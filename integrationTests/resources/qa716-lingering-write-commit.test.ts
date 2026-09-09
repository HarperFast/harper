/**
 * Promoted from qa-explorer (QA-716 / P-493): regression anchor for PR harper#1860
 * ("fix(txn): don't drop writes staged while read iterators defer the commit").
 *
 * Invariant: once a request is acknowledged, every write it staged is durable and its secondary
 * index agrees with the base store — immediately, not eventually — even though the request left a
 * read iterator open past its own commit.
 *
 * Why an integration anchor on top of unitTests/resources/lingeringWriteCommit.test.js, which
 * shipped with the fix: that covers the single-table case against the transaction object in
 * isolation. Here the same mechanism runs through the whole request path with the factors a real
 * fulfillment endpoint combines — writes staged across three tables in one request transaction, a
 * paged secondary-index iterator the handler never drains or closes, TTL eviction racing the
 * deferred commit, and four worker threads.
 *
 * Pre-#1860, commit() saw readTxnsUsed > 0 from the abandoned iterator, set open=LINGERING and
 * returned WITHOUT committing; the writes could only be flushed from doneReadTxn(), which nothing
 * ever called, and the HTTP response had already resolved 200. That is the loss this pins against.
 * RocksDB-only in substance: LMDB never defers a commit on open read transactions, so under
 * HARPER_STORAGE_ENGINE=lmdb the suite is a no-delta control.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/resources/qa716-lingering-write-commit.test.ts"
 *   (lmdb control: HARPER_STORAGE_ENGINE=lmdb npm run test:integration -- "<same path>")
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa716-lingering-write-commit');
const SCHEMA = 'data';
const ENGINE = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? 'lmdb' : 'rocksdb';
// Low threshold so the long-transaction monitor reaches the abandoned-iterator transaction well
// inside Q3's wait window (it fires ~2x this value after the last read-txn touch).
const MAX_TXN_OPEN_MS = 1000;
const PAGE_SIZE = 5;
const skipSuite = process.platform === 'win32';

suite(`QA-716 lingering-write-commit vs staged writes [${ENGINE}]`, { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let httpURL: string;
	let procOutput = '';

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 4 },
				storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS, debugLongTransactions: true },
				// 'warn', not 'error': #1860's release-only monitor branch logs at warn level, and an
				// 'error' threshold would swallow it and make Q3's diagnostic blind.
				logging: { console: true, level: 'warn' },
			},
			env: {},
		});
		client = createApiClient(ctx.harper);
		httpURL = ctx.harper.httpURL;

		procOutput += ctx.harper.startupOutput?.stdout ?? '';
		procOutput += ctx.harper.startupOutput?.stderr ?? '';
		const proc = ctx.harper.process;
		proc?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
		proc?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

		let ready = false;
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Orders/').timeout(2000);
				if (probe.status !== 404) {
					ready = true;
					break;
				}
			} catch {
				/* not ready yet */
			}
			await sleep(250);
		}
		ok(ready, 'REST route /Orders/ never became available within 120s — the fixture did not install');
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	function postJSON(path: string, body: unknown): Promise<Response> {
		return fetch(`${httpURL}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
			body: JSON.stringify(body),
		});
	}

	function fullLog(): string {
		let logText = '';
		const logDir = ctx.harper.logDir;
		if (logDir) {
			for (const name of ['hdb.log', 'stdout.log', 'stderr.log']) {
				const p = join(logDir, name);
				if (existsSync(p)) {
					try {
						logText += readFileSync(p, 'utf8');
					} catch {
						/* a log file may rotate mid-read; the process capture below still covers it */
					}
				}
			}
		}
		return logText + procOutput;
	}

	async function searchByValue(table: string, attribute: string, value: string): Promise<Set<string>> {
		const r = await client
			.req()
			.send({
				operation: 'search_by_value',
				schema: SCHEMA,
				table,
				search_attribute: attribute,
				search_value: value,
				get_attributes: ['*'],
			})
			.timeout(30_000)
			.expect(200);
		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		return new Set(rows.map((row) => String(row.id)));
	}

	async function getById(table: string, id: string): Promise<any | null> {
		const r = await client
			.req()
			.send({ operation: 'search_by_id', schema: SCHEMA, table, ids: [id], get_attributes: ['*'] })
			.timeout(30_000)
			.expect(200);
		const rows: any[] = Array.isArray(r.body) ? r.body : [];
		return rows.length ? rows[0] : null;
	}

	async function dump(path: string): Promise<any[]> {
		const r = await fetch(`${httpURL}${path}`, { headers: { Authorization: client.headers.Authorization } });
		strictEqual(r.status, 200, `${path} should return 200`);
		return (await r.json()) as any[];
	}

	async function seed(bucket: string, count: number) {
		const res = await postJSON('/Seed/', { bucket, count });
		strictEqual(res.status, 200, `seed ${bucket} should succeed`);
		return res.json();
	}

	async function fulfillPage(bucket: string, pageSize: number) {
		const res = await postJSON('/FulfillPage/', { bucket, pageSize });
		strictEqual(res.status, 200, `FulfillPage(${bucket}) should succeed`);
		return res.json() as Promise<{ ok: boolean; bucket: string; fulfilledIds: string[]; scanned: number }>;
	}

	/** Must hold immediately after the ack, not eventually. The two index reads are hoisted out of
	 *  the loop: per id they would be 2N sequential full-index scans, which is both slow and a
	 *  widening window for anything in the suite that races a TTL. */
	async function assertOrdersDurablyFulfilled(ids: string[]) {
		const fulfilledHits = await searchByValue('Orders', 'status', 'fulfilled');
		const pendingHits = await searchByValue('Orders', 'status', 'pending');
		for (const id of ids) {
			const byId = await getById('Orders', id);
			ok(byId, `Orders/${id}: base row must exist`);
			strictEqual(byId?.status, 'fulfilled', `Orders/${id}: base row status must be 'fulfilled'`);
			ok(fulfilledHits.has(id), `Orders/${id}: must appear in status='fulfilled' index search`);
			ok(!pendingHits.has(id), `Orders/${id}: must NOT still appear in status='pending' index (stale/phantom entry)`);
		}
	}

	let q1Bucket: string;
	let q1FulfilledIds: string[];
	let q1Sku: string;

	test('Q1 order fulfilled behind an abandoned read iterator is durable and index-consistent immediately', async () => {
		q1Bucket = 'B1';
		q1Sku = `SKU-${q1Bucket}`;
		await seed(q1Bucket, 20);
		const { fulfilledIds, scanned } = await fulfillPage(q1Bucket, PAGE_SIZE);
		q1FulfilledIds = fulfilledIds;
		strictEqual(fulfilledIds.length, PAGE_SIZE, `FulfillPage should pick a full page of ${PAGE_SIZE}`);
		console.log(`[QA-716 Q1 ${ENGINE}] fulfilled=${JSON.stringify(fulfilledIds)} scanned=${scanned}`);

		// Read the TTL'd table before the index round trips below, not after: a slow shard can
		// otherwise spend the expiry window on unrelated work.
		const reservations = (await dump('/DumpReservation/')).filter((r: any) => r.sku === q1Sku);
		strictEqual(
			reservations.length,
			PAGE_SIZE,
			'a Reservation row must exist for every fulfilled order (3rd table, same txn)'
		);

		await assertOrdersDurablyFulfilled(fulfilledIds);

		const inv = (await dump('/DumpInventory/')).find((r: any) => r.sku === q1Sku);
		ok(inv, `Inventory/${q1Sku} must exist`);
		strictEqual(
			inv.fulfilledCount,
			PAGE_SIZE,
			`Inventory/${q1Sku}.fulfilledCount must reflect all ${PAGE_SIZE} staged writes`
		);
	});

	test(
		'Q2 TTL: reservations staged behind the lingering commit expire with no orphaned index entries',
		{ timeout: 60_000 },
		async () => {
			// Its own bucket, fulfilled here rather than reused from Q1. Sharing Q1's rows would put
			// Q1's remaining index reads inside this arm's expiry window, so a slow shard could expire
			// correctly-committed reservations before the floor below ever looks at them.
			const bucket = 'B2';
			const sku = `SKU-${bucket}`;
			await seed(bucket, 20);
			const { fulfilledIds } = await fulfillPage(bucket, PAGE_SIZE);
			strictEqual(fulfilledIds.length, PAGE_SIZE, `FulfillPage(${bucket}) should pick a full page`);

			// Read immediately: search hides a row once expiresAt has passed, independently of the
			// sweep (resources/Table.ts, `!includeExpired && entry?.expiresAt < Date.now()`), so this
			// floor is on wall-clock time from the fulfillPage above, not on sweep progress.
			const preSweep = (await dump('/DumpReservation/')).filter((r: any) => r.sku === sku);
			// Vacuity floor: with an already-empty table the expiry assertions below are trivially
			// true, so a run that lost the staged writes upstream would pass while proving nothing.
			strictEqual(
				preSweep.length,
				PAGE_SIZE,
				`the ${PAGE_SIZE} Reservation rows staged behind the lingering commit must be present for the TTL axis to mean anything`
			);

			const deadline = Date.now() + 30_000;
			let remaining = preSweep.length;
			while (Date.now() < deadline) {
				remaining = (await dump('/DumpReservation/')).filter((r: any) => r.sku === sku).length;
				if (remaining === 0) break;
				await sleep(1000);
			}
			strictEqual(remaining, 0, 'no Reservation row for this sku may still be returned once its TTL has elapsed');

			// Index cleanup lags the base-row delete, so poll a bounded settle window. Scope: search_by_value
			// materializes its hits and drops any whose base record is gone (resources/Table.ts,
			// `if (record == null) return canSkip ? SKIP : record`), so this proves the index no longer
			// RESOLVES an evicted reservation. A dangling entry whose base row is already deleted would
			// need a raw-index read the operations API does not expose.
			const indexDeadline = Date.now() + 10_000;
			let indexHits = await searchByValue('Reservation', 'sku', sku);
			while (indexHits.size > 0 && Date.now() < indexDeadline) {
				await sleep(500);
				indexHits = await searchByValue('Reservation', 'sku', sku);
			}
			strictEqual(indexHits.size, 0, 'the sku index must resolve no Reservation rows once the TTL sweep has run');
		}
	);

	test('Q3 durability holds past the long-transaction monitor threshold', async () => {
		strictEqual(q1FulfilledIds?.length, PAGE_SIZE, 'Q1 must have fulfilled a page for this arm to re-check anything');
		// Elapsed time, not a convergence wait: the claim is that nothing happens to these writes
		// once the monitor reaches the abandoned transaction, so there is no event to converge on.
		await sleep(Math.max(6000, MAX_TXN_OPEN_MS * 6));
		const log = fullLog();
		// Diagnostics. The abort line is not asserted absent: any other transaction in the run may
		// legitimately cross the deliberately-low threshold and log it.
		const abortedLine = /Transaction was open too long and has been aborted/i.test(log);
		const releasedLine = /Read iterators held a committed transaction.s snapshot/i.test(log);
		console.log(
			`[QA-716 Q3 ${ENGINE}] monitor lines seen: aborted-with-writes-discarded=${abortedLine} released-handle-only=${releasedLine}`
		);

		await assertOrdersDurablyFulfilled(q1FulfilledIds);
		const inv = (await dump('/DumpInventory/')).find((r: any) => r.sku === q1Sku);
		strictEqual(
			inv?.fulfilledCount,
			PAGE_SIZE,
			`Inventory/${q1Sku}.fulfilledCount must still reflect all ${PAGE_SIZE} writes post-monitor`
		);
	});

	test(
		'Q4 concurrency: 8 concurrent bucket-isolated lingering commits all land correctly',
		{ timeout: 60_000 },
		async () => {
			const buckets = Array.from({ length: 8 }, (_, i) => `C${i + 1}`);
			await Promise.all(buckets.map((b) => seed(b, 20)));
			const results = await Promise.all(buckets.map((b) => fulfillPage(b, PAGE_SIZE)));

			for (let i = 0; i < buckets.length; i++) {
				strictEqual(
					results[i].fulfilledIds.length,
					PAGE_SIZE,
					`${buckets[i]}: should fulfill a full page of ${PAGE_SIZE}`
				);
			}

			let totalChecked = 0;
			for (let i = 0; i < buckets.length; i++) {
				const sku = `SKU-${buckets[i]}`;
				await assertOrdersDurablyFulfilled(results[i].fulfilledIds);
				totalChecked += results[i].fulfilledIds.length;
				const inv = (await dump('/DumpInventory/')).find((r: any) => r.sku === sku);
				strictEqual(
					inv?.fulfilledCount,
					PAGE_SIZE,
					`Inventory/${sku}.fulfilledCount must reflect its own bucket's ${PAGE_SIZE} writes only`
				);
			}
			strictEqual(
				totalChecked,
				buckets.length * PAGE_SIZE,
				`every bucket's page must have been verified, not a subset`
			);
			console.log(
				`[QA-716 Q4 ${ENGINE}] concurrently verified ${totalChecked} durably-fulfilled orders across 8 buckets`
			);

			const allOrders = await dump('/DumpOrders/');
			for (const bucket of buckets) {
				const bucketOrders = allOrders.filter((o: any) => o.bucket === bucket);
				const fulfilled = bucketOrders.filter((o: any) => o.status === 'fulfilled');
				strictEqual(
					fulfilled.length,
					PAGE_SIZE,
					`${bucket}: exactly ${PAGE_SIZE} base rows should show status='fulfilled'`
				);
			}
		}
	);
});
