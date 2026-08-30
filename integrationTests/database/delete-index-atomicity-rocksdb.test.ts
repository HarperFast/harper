/**
 * Regression anchor for #1854 (fixed by PR #1869, merged as e755a0d0e): on RocksDB, a delete on
 * an `audit:false` @indexed table must not commit the base-row removal independently of the
 * secondary-index removal.
 *
 * `_writeDelete()`'s non-audit commit branch (resources/Table.ts) removes the base row with
 * `removeEntry(primaryStore, existingEntry, ...)` while removing the index entries with
 * `updateIndices(id, existingRecord, null, transaction && { transaction })`. `removeEntry()`
 * hands its options straight to `store.remove(key, options)`, so before #1869 — which added the
 * `isRocksDB && transaction ? { transaction } : undefined` argument — the base-row removal
 * committed standalone against the raw store. An aborted transaction therefore still durably
 * removed the row (and unlinked its blob, since the blob-unlink gate keys off the removal's own
 * commit) while the transaction-scoped index removal rolled back, leaving the secondary index
 * pointing at a primary key that no longer exists. `audit: true` is unaffected: that branch
 * removes through `updateRecord()`, which has always threaded `{transaction}`.
 *
 * `integrationTests/resources/audit-false-delete-rollback.test.ts` pins the same fix through the
 * client surfaces. This file pins it at the storage layer instead, because the client surfaces
 * cannot see half of the damage: `search_by_value` joins each index entry back through its
 * primary record and silently drops the ones whose record is gone, so a dangling entry is
 * invisible to every query API. The oracle here is a second, independent, read-only
 * `@harperfast/rocksdb-js` handle on the on-disk column families, decoding the composite
 * `[indexedValue, primaryKey]` index keys itself (the wire format written by
 * resources/RocksIndexStore.ts), with no Harper code in the read path. It also covers the
 * monitor-fired abort (Arm A) alongside #1869's request-thrown abort (Arm B).
 *
 * A RocksDB `readOnly: true` open is a point-in-time snapshot of the SSTs as of that open, not a
 * live view like LMDB's shared mmap, and Harper opens table/index column families with
 * `disableWAL` defaulting to true (resources/databases.ts openRocksDatabase), so a committed
 * write can still sit only in the writer's memtable. An oracle that skips either step reports a
 * clean run from flush timing rather than from real consistency, so `refreshOracle()` flushes
 * through the fixture and reopens every handle before each raw read, and the 'oracle proof'
 * tests below demonstrate — rather than assert — that it detects a phantom the join cannot.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/delete-index-atomicity-rocksdb.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, notStrictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { RocksDatabase } from '@harperfast/rocksdb-js';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'delete-index-atomicity-rocksdb');
const SCHEMA = 'data';
const MAX_TXN_OPEN_MS = 1000;
// The monitor ticks once per `storage.maxTransactionOpenTime` and decays a transaction's budget
// by one interval per tick (resources/DatabaseTransaction.ts startMonitoringTxns), so the abort
// lands within ~2-3 ticks. This hold is an order of magnitude past that, purely as slack for a
// loaded runner; the arm asserts on the log line the monitor actually emitted, never on elapsed
// wall-clock.
const HOLD_MS = 15_000;
const skipSuite = process.platform === 'win32';

suite(
	'#1854 audit:false delete must not orphan secondary-index entries (raw RocksDB oracle)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		let procOutput = '';
		let rootPath: string;
		const dbiCache = new Map<string, RocksDatabase>();

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: {
					storage: { maxTransactionOpenTime: MAX_TXN_OPEN_MS, debugLongTransactions: true },
					logging: { console: true, level: 'error' },
				},
				env: { HARPER_STORAGE_ENGINE: 'rocksdb' },
			});
			client = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;

			procOutput += ctx.harper.startupOutput?.stdout ?? '';
			procOutput += ctx.harper.startupOutput?.stderr ?? '';
			const proc = ctx.harper.process;
			proc?.stdout?.on('data', (d: Buffer) => (procOutput += d.toString()));
			proc?.stderr?.on('data', (d: Buffer) => (procOutput += d.toString()));

			// Workers register routes asynchronously; poll the probe route rather than restarting the
			// http workers, which races against a pre-installed fixture.
			const routeDeadline = Date.now() + 120_000;
			let ready = false;
			while (Date.now() < routeDeadline) {
				try {
					const probe = await fetch(`${httpURL}/Probe/`, { headers: { Authorization: client.headers.Authorization } });
					if (probe.status !== 404) {
						ready = true;
						break;
					}
				} catch {
					/* not ready yet */
				}
				await sleep(250);
			}
			ok(ready, 'Probe route should become available before the suite runs');

			// The audit flag is what selects the branch each arm targets, so a schema drift that
			// flipped it would turn this anchor green for the wrong reason.
			const itemF = await (await getJSON('/TableInfo/?table=ItemF')).json();
			const itemT = await (await getJSON('/TableInfo/?table=ItemT')).json();
			strictEqual(itemF.audit, false, 'ItemF must be audit:false to reach the branch this anchor pins');
			strictEqual(itemT.audit, true, 'ItemT must be audit:true to serve as the control arm');

			// The RocksDB root store for a database is a directory (not a single file as on LMDB) at
			// `{dataRootDir}/database/{name}`, shared by every table and index column family in it.
			rootPath = join(ctx.harper.dataRootDir, 'database', SCHEMA);
			const dirDeadline = Date.now() + 30_000;
			while (!existsSync(rootPath) && Date.now() < dirDeadline) await sleep(200);
			ok(existsSync(rootPath), `expected RocksDB directory at ${rootPath}`);
		});

		after(async () => {
			for (const db of dbiCache.values()) {
				try {
					db.close();
				} catch {
					/* ignore */
				}
			}
			dbiCache.clear();
			await teardownHarper(ctx);
		});

		function postJSON(path: string, body: unknown): Promise<Response> {
			return fetch(`${httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
				body: JSON.stringify(body),
			});
		}
		function getJSON(path: string): Promise<Response> {
			return fetch(`${httpURL}${path}`, { headers: { Authorization: client.headers.Authorization } });
		}

		function sawLog(pattern: RegExp): boolean {
			let logText = procOutput;
			if (ctx.harper.logDir) {
				for (const name of ['hdb.log', 'stdout.log', 'stderr.log']) {
					const p = join(ctx.harper.logDir, name);
					if (existsSync(p)) {
						try {
							logText += readFileSync(p, 'utf8');
						} catch {
							/* ignore */
						}
					}
				}
			}
			return pattern.test(logText);
		}

		/**
		 * Must precede every raw read: flush the memtables through the fixture so committed writes
		 * are on disk, then drop every cached handle so the next open is a fresh snapshot rather
		 * than the stale point-in-time view the previous open captured.
		 */
		async function refreshOracle(): Promise<void> {
			const res = await postJSON('/Flush/', {});
			strictEqual(res.status, 200, 'flush control should succeed');
			for (const db of dbiCache.values()) {
				try {
					db.close();
				} catch {
					/* ignore */
				}
			}
			dbiCache.clear();
		}
		function openDbi(name: string): RocksDatabase {
			if (!dbiCache.has(name)) dbiCache.set(name, RocksDatabase.open(rootPath, { name, readOnly: true }));
			return dbiCache.get(name)!;
		}
		/** Primary keys present in the on-disk primary store, read without consulting any index. */
		function rawPrimaryKeys(table: string): Set<string> {
			return new Set([...openDbi(`${table}/`).getKeys()].map(String));
		}
		/**
		 * {category, id} pairs read straight out of the on-disk secondary-index column family.
		 * RocksIndexStore encodes each entry as an ordered-binary `[indexedValue, primaryKey]` key
		 * with a null value; the plain RocksDatabase class decodes that key here, with no Harper
		 * subclass interpreting it.
		 */
		function rawIndexEntries(table: string, attribute: string): Array<{ key: string; id: string }> {
			return [...openDbi(`${table}/${attribute}`).getRange()].map((e: { key: [unknown, unknown] }) => ({
				key: String(e.key[0]),
				id: String(e.key[1]),
			}));
		}
		/** Index entries whose id has no primary record — the dangling entries #1854 produced. */
		function findPhantoms(table: string, attribute: string): Array<{ key: string; id: string }> {
			const primaryKeys = rawPrimaryKeys(table);
			return rawIndexEntries(table, attribute).filter((e) => !primaryKeys.has(e.id));
		}

		test('oracle proof: sees a seeded index entry, and sees it vanish on a normal delete', async () => {
			await postJSON('/Seed/', { table: 'ItemF', ids: [{ id: 'proof-1', category: 'PROOF' }] });
			await refreshOracle();
			let entries = rawIndexEntries('ItemF', 'category').filter((e) => e.key === 'PROOF');
			let keys = rawPrimaryKeys('ItemF');
			strictEqual(entries.length, 1, 'oracle should see exactly 1 raw index entry for PROOF after seed');
			strictEqual(entries[0].id, 'proof-1', 'raw index entry should point at proof-1');
			ok(keys.has('proof-1'), 'oracle should see proof-1 in the raw primary store after seed');

			const res = await postJSON('/DeleteOne/', { table: 'ItemF', id: 'proof-1' });
			strictEqual(res.status, 200, 'ordinary delete should succeed');

			await refreshOracle();
			entries = rawIndexEntries('ItemF', 'category').filter((e) => e.key === 'PROOF');
			keys = rawPrimaryKeys('ItemF');
			strictEqual(entries.length, 0, 'oracle should see the PROOF index entry vanish after a normal delete');
			ok(!keys.has('proof-1'), 'oracle should see proof-1 vanish from the raw primary store after a normal delete');
		});

		test('oracle proof: detects an injected phantom that the join-based query surface cannot', async () => {
			const res = await postJSON('/InjectPhantom/', { table: 'ItemF', category: 'GHOST', id: 'ghost-1' });
			strictEqual(res.status, 200, 'InjectPhantom control should succeed (ghost-1 must not already exist)');

			await refreshOracle();
			ok(!rawPrimaryKeys('ItemF').has('ghost-1'), 'ghost-1 should never appear in the raw primary store');

			const phantoms = findPhantoms('ItemF', 'category');
			ok(
				phantoms.some((p) => p.id === 'ghost-1' && p.key === 'GHOST'),
				`oracle should detect the injected phantom (GHOST -> ghost-1); phantoms seen: ${JSON.stringify(phantoms)}`
			);

			const blind = await (await getJSON('/BlindSearch/?table=ItemF&category=GHOST')).json();
			strictEqual(
				blind.hits.length,
				0,
				'the join-through-primary query surface must see 0 hits for the same phantom, which is why the arms below read raw storage'
			);

			// Remove the deliberate artifact so the table-wide scans in Arm A/B cannot report it as a
			// genuine phantom (or have a genuine one masked by it).
			const cleanup = await postJSON('/RemoveIndexEntry/', { table: 'ItemF', category: 'GHOST', id: 'ghost-1' });
			strictEqual(cleanup.status, 200, 'positive-control cleanup should succeed');
			await refreshOracle();
			ok(
				findPhantoms('ItemF', 'category').every((p) => p.id !== 'ghost-1'),
				'ghost-1 phantom should be gone after cleanup'
			);
		});

		// Arm A: the abort is fired by the long-transaction monitor mid-transaction, not by the
		// handler — a different path into the same commit branch than #1869's own test covers.
		for (const table of ['ItemF', 'ItemT']) {
			test(
				`Arm A (${table}): monitor-fired abort mid insert/update/remove leaves base and index in agreement`,
				{ timeout: HOLD_MS + 60_000 },
				async () => {
					await postJSON('/Seed/', {
						table,
						ids: [
							{ id: '__seed__-0', category: '__seed__' },
							{ id: `${table}-upd-base`, category: 'ARMA-OLD' },
							{ id: `${table}-rm-base`, category: 'ARMA-DEL' },
						],
					});

					const res = await postJSON('/SlowMixedHold/', {
						table,
						insertIds: [
							{ id: `${table}-ins-1`, category: 'ARMA-NEW' },
							{ id: `${table}-ins-2`, category: 'ARMA-NEW' },
						],
						updateId: `${table}-upd-base`,
						updateCategory: 'ARMA-UPDATED',
						removeId: `${table}-rm-base`,
						markerId: `${table}-marker`,
						holdMs: HOLD_MS,
					});
					const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

					// The monitor's decision is asynchronous to the request returning, so wait for the
					// evidence itself rather than for a fixed settling delay.
					const overTime = /Transaction was open too long and has been (aborted|committed)/i;
					const logDeadline = Date.now() + 15_000;
					while (!sawLog(overTime) && Date.now() < logDeadline) await sleep(100);
					const abortedLine = sawLog(/Transaction was open too long and has been aborted/i);
					const committedLine = sawLog(/Transaction was open too long and has been committed/i);
					ok(
						abortedLine || committedLine,
						`the over-time monitor must actually have fired for ${table}; status=${res.status} body=${JSON.stringify(body)}`
					);

					await refreshOracle();
					const phantoms = findPhantoms(table, 'category');
					const primaryKeys = rawPrimaryKeys(table);
					const indexEntries = rawIndexEntries(table, 'category');
					// The other direction: any row that survived in the primary store must still be
					// reachable through the index. Both the updated and the pre-image category are listed
					// because whether the update landed depends on which side of the abort it fell on, and
					// either outcome is consistent as long as some index entry exists for the surviving row.
					const missing: string[] = [];
					for (const id of [`${table}-upd-base`, `${table}-ins-1`, `${table}-ins-2`]) {
						if (!primaryKeys.has(id)) continue;
						if (!indexEntries.some((ie) => ie.id === id)) missing.push(`${id} present in primary but not indexed`);
					}

					console.log(
						`\n[#1854 Arm A ${table}] status=${res.status} aborted=${abortedLine} committed=${committedLine}\n` +
							`  phantoms=${phantoms.length}${phantoms.length ? ' ' + JSON.stringify(phantoms) : ''}` +
							` missing=${missing.length}${missing.length ? ' ' + JSON.stringify(missing) : ''}` +
							` removeId-still-in-primary=${primaryKeys.has(`${table}-rm-base`)}`
					);

					strictEqual(
						phantoms.length,
						0,
						`Arm A (${table}): index entries pointing at absent primary records: ${JSON.stringify(phantoms)}`
					);
					strictEqual(
						missing.length,
						0,
						`Arm A (${table}): primary records with no index entry: ${JSON.stringify(missing)}`
					);
				}
			);
		}

		// Arm B: #1854's original trigger — a delete followed by a thrown error — observed at the
		// storage layer, where the phantom the query surfaces cannot show is visible.
		for (const table of ['ItemF', 'ItemT']) {
			test(`Arm B (${table}): request-thrown abort after a delete leaves base and index in agreement`, async () => {
				const id = `${table}-abort-1`;
				await postJSON('/Seed/', { table, ids: [{ id, category: 'ARMB' }] });

				const res = await postJSON('/DeleteThenAbort/', { table, id });
				notStrictEqual(res.status, 200, 'DeleteThenAbort handler should surface its deliberate throw as a non-200');

				await refreshOracle();
				const primaryHasId = rawPrimaryKeys(table).has(id);
				const indexHasEntry = rawIndexEntries(table, 'category').some((e) => e.key === 'ARMB' && e.id === id);

				console.log(
					`\n[#1854 Arm B ${table}] status=${res.status} primaryHasId=${primaryHasId} indexHasEntry=${indexHasEntry}`
				);

				strictEqual(
					indexHasEntry,
					primaryHasId,
					`Arm B (${table}): base row and index entry must agree on whether id=${id} exists (primaryHasId=${primaryHasId}, indexHasEntry=${indexHasEntry})`
				);
			});
		}
	}
);
