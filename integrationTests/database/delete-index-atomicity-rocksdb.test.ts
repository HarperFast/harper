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
 * client surfaces. Those surfaces cannot see half of the damage: `search_by_value` joins each
 * index entry back through its primary record and silently drops the ones whose record is gone,
 * so a dangling entry is invisible to every query API. The oracle here is a second, independent,
 * read-only `@harperfast/rocksdb-js` handle on the secondary-index column families, decoding the
 * composite `[indexedValue, primaryKey]` index keys itself (the wire format written by
 * resources/RocksIndexStore.ts) rather than asking Harper what they mean. Primary-record liveness
 * is a direct point lookup by primary key, which no index mediates — `hasLiveRecord()` says why
 * the raw primary column family cannot answer it. It also covers the monitor-fired abort (Arm A)
 * alongside #1869's request-thrown abort (Arm B).
 *
 * The oracle reads a RocksDB checkpoint, never the live database directory. `readOnly: true` maps
 * to `rocksdb::DB::OpenForReadOnly`, which replays the MANIFEST into a file list and then opens
 * those files while holding no reference on any of them, so a compaction in the process under test
 * can unlink one inside that window and the open fails as MANIFEST corruption
 * (HarperFast/rocksdb-js#812). Nothing writes to a checkpoint, so the race cannot happen there, and
 * `createCheckpoint()` flushes the memtable — which the oracle needs anyway, since Harper opens
 * table/index column families with `disableWAL` defaulting to true (resources/databases.ts
 * openRocksDatabase) and a committed write can otherwise sit only in the writer's memtable. One
 * checkpoint covers every column family at a single point in time, so no arm can read two families
 * from two different instants. `refreshOracle()` takes a fresh one and reopens every handle before
 * each raw read, and the 'oracle proof' tests below demonstrate — rather than assert — that the
 * oracle really reads that snapshot, and that it detects a phantom the join cannot, on both tables.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/delete-index-atomicity-rocksdb.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
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
// loaded runner; the arm asserts on the log line the monitor emitted for its own request, never
// on elapsed wall-clock.
const HOLD_MS = 15_000;
const LOG_FILES = ['hdb.log', 'stdout.log', 'stderr.log'];
// Where the fixture puts a checkpoint; derived independently here so that a fixture regression
// handing back a live directory fails the assertion in refreshOracle() rather than being opened.
const SNAPSHOT_DIR = 'oracle-snapshots';
const skipSuite = process.platform === 'win32';

suite(
	'#1854 audit:false delete must not orphan secondary-index entries (raw RocksDB oracle)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		const procChunks: string[] = [];
		let rootPath: string;
		let snapshotPath: string | undefined;
		let snapshotSeq = 0;
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

			procChunks.push(ctx.harper.startupOutput?.stdout ?? '', ctx.harper.startupOutput?.stderr ?? '');
			const proc = ctx.harper.process;
			// setEncoding keeps a multi-byte sequence split across chunk boundaries intact; collecting
			// chunks instead of concatenating keeps a chatty run from being quadratic.
			proc?.stdout?.setEncoding('utf8');
			proc?.stderr?.setEncoding('utf8');
			proc?.stdout?.on('data', (d: string) => procChunks.push(d));
			proc?.stderr?.on('data', (d: string) => procChunks.push(d));

			// Workers register routes asynchronously; poll the probe route rather than restarting the
			// http workers, which races against a pre-installed fixture.
			const routeDeadline = Date.now() + 120_000;
			let ready = false;
			let lastProbeError = 'no response yet';
			while (Date.now() < routeDeadline) {
				try {
					// Strictly 200: a worker that crashed on a fixture error answers 500, and treating that
					// as ready turns a startup failure into opaque failures in the arms below.
					const probe = await fetch(`${httpURL}/Probe/`, { headers: { Authorization: client.headers.Authorization } });
					if (probe.status === 200) {
						ready = true;
						break;
					}
					lastProbeError = `status ${probe.status}`;
				} catch (error) {
					lastProbeError = String((error as Error)?.message ?? error);
				}
				await sleep(250);
			}
			ok(ready, `Probe route should become available before the suite runs; last probe: ${lastProbeError}`);

			// `audit || trackDeletes` is what selects the branch each arm targets (resources/Table.ts),
			// and `trackDeletes` can be turned on implicitly by adding a subscribed source, so a drift
			// in either would retire this anchor while leaving it green.
			const itemF = await (await getJSON('/TableInfo/?table=ItemF')).json();
			const itemT = await (await getJSON('/TableInfo/?table=ItemT')).json();
			strictEqual(itemF.audit, false, 'ItemF must be audit:false to reach the branch this anchor pins');
			ok(!itemF.trackDeletes, 'ItemF must not track deletes, which would route it through updateRecord() instead');
			strictEqual(itemT.audit, true, 'ItemT must be audit:true to serve as the control arm');

			// The RocksDB root store for a database is a directory (not a single file as on LMDB) at
			// `{dataRootDir}/database/{name}`, shared by every table and index column family in it. The
			// oracle checkpoints it rather than opening it; this is the writer's copy, and the negative
			// the snapshot proof below asserts against.
			rootPath = join(ctx.harper.dataRootDir, 'database', SCHEMA);
			const dirDeadline = Date.now() + 30_000;
			while (!existsSync(rootPath) && Date.now() < dirDeadline) await sleep(200);
			ok(existsSync(rootPath), `expected RocksDB directory at ${rootPath}`);
		});

		after(async () => {
			closeOracleHandles();
			try {
				await removeSnapshot();
			} finally {
				await teardownHarper(ctx);
			}
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

		function logSources(): Map<string, string> {
			const sources = new Map<string, string>([['<stdio>', procChunks.join('')]]);
			if (ctx.harper.logDir) {
				for (const name of LOG_FILES) {
					const p = join(ctx.harper.logDir, name);
					if (!existsSync(p)) continue;
					try {
						sources.set(p, readFileSync(p, 'utf8'));
					} catch {
						/* ignore */
					}
				}
			}
			return sources;
		}
		/**
		 * With `maxTransactionOpenTime` pinned to a second, any Harper-internal transaction that
		 * outlives it — during startup, or in an earlier arm — emits the same over-time line, after
		 * which an unscoped search matches forever and every later arm's monitor proof is vacuous.
		 * Each arm therefore marks the logs immediately before its own request and matches only what
		 * was appended after that point.
		 */
		function markLogs(): Map<string, number> {
			return new Map([...logSources()].map(([name, text]) => [name, text.length]));
		}
		function sawLogSince(mark: Map<string, number>, pattern: RegExp): boolean {
			for (const [name, text] of logSources()) if (pattern.test(text.slice(mark.get(name) ?? 0))) return true;
			return false;
		}

		function closeOracleHandles(): void {
			for (const db of dbiCache.values()) {
				try {
					db.close();
				} catch {
					/* ignore */
				}
			}
			dbiCache.clear();
		}
		/** Removing before taking the next one bounds the hardlinked SSTs a snapshot pins to one. */
		async function removeSnapshot(): Promise<void> {
			if (!snapshotPath) return;
			const stale = snapshotPath;
			snapshotPath = undefined;
			await rm(stale, { recursive: true, force: true });
		}
		/** Must precede every raw read; see the file header for why the oracle reads a checkpoint. */
		async function refreshOracle(): Promise<void> {
			closeOracleHandles();
			await removeSnapshot();
			const res = await postJSON('/Snapshot/', { seq: ++snapshotSeq });
			const body = await res.text();
			strictEqual(res.status, 200, `snapshot control should succeed; got ${res.status} ${body.slice(0, 300)}`);
			strictEqual(
				JSON.parse(body).path,
				join(ctx.harper.dataRootDir, SNAPSHOT_DIR, String(snapshotSeq)),
				'the oracle must only ever open a checkpoint at the path the fixture derives for this sequence'
			);
			snapshotPath = JSON.parse(body).path;
		}
		function openDbi(name: string): RocksDatabase {
			// Reading the live directory instead would reintroduce the compaction race the checkpoint
			// exists to remove, so an unrefreshed oracle is a test bug, not a fallback.
			if (!snapshotPath) throw new Error('oracle read before refreshOracle(): there is no checkpoint to read');
			if (!dbiCache.has(name)) dbiCache.set(name, RocksDatabase.open(snapshotPath, { name, readOnly: true }));
			return dbiCache.get(name)!;
		}
		/**
		 * Whether a live record exists under this primary key, via a direct point lookup that no
		 * index mediates. The raw primary column family cannot answer this: an audited delete routes
		 * through `updateRecord(id, null, ...)` (resources/Table.ts) and `RecordEncoder.ts` only skips
		 * the write when the record is `undefined`, so `null` is stored as a tombstone under the same
		 * key until cleanup runs — measured here, where ItemT's key survives a committed delete. The
		 * encoded value's payload offset is variable (version, then a 2- or 4-byte metadata word, then
		 * optional expiration/residency/node-id fields), so reading liveness out of the raw bytes would
		 * be a guess. The index side, which is where the query surfaces are blind, stays raw.
		 */
		async function hasLiveRecord(table: string, id: string): Promise<boolean> {
			const res = await getJSON(`/${table}/${encodeURIComponent(id)}`);
			if (res.status === 200) return true;
			if (res.status === 404) return false;
			// Anything else is the oracle failing, not an answer. Treating it as "absent" would let a
			// 500 from the just-poisoned thread fabricate a phantom and fail the arm with a message
			// claiming the index is orphaned.
			throw new Error(`liveness probe for ${table}/${id} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
		/** Index entries whose id has no live record — the dangling entries #1854 produced. */
		async function findPhantoms(table: string, attribute: string): Promise<Array<{ key: string; id: string }>> {
			const entries = rawIndexEntries(table, attribute);
			const live = new Map<string, boolean>();
			for (const e of entries) if (!live.has(e.id)) live.set(e.id, await hasLiveRecord(table, e.id));
			return entries.filter((e) => !live.get(e.id));
		}

		async function seed(table: string, ids: Array<{ id: string; category: string }>): Promise<void> {
			const res = await postJSON('/Seed/', { table, ids });
			strictEqual(res.status, 200, `seeding ${table} must succeed, or every assertion below is vacuous`);
		}

		// No assertion about the data can show which directory the handles were opened against: one
		// left pointing at the live database returns the same rows and differs only by being able to
		// lose its open to a compaction — the failure this suite exists to stop reproducing.
		test('oracle proof: the raw handles read an immutable checkpoint, not the live database', async () => {
			await seed('ItemF', [{ id: 'snapshot-1', category: 'SNAPSHOT' }]);
			await refreshOracle();
			const firstSnapshot = snapshotPath!;
			ok(firstSnapshot !== rootPath, `the oracle must open a checkpoint, not ${rootPath}`);
			strictEqual(
				openDbi('ItemF/category').path,
				firstSnapshot,
				'the raw column-family handle must be opened against that checkpoint'
			);
			ok(
				rawIndexEntries('ItemF', 'category').some((e) => e.key === 'SNAPSHOT' && e.id === 'snapshot-1'),
				'the checkpoint must contain the write that preceded it'
			);

			// Flushed, so snapshot-2 is durably in the live directory's own SSTs: the only thing that
			// can keep the oracle from seeing it now is that the oracle is not reading that directory.
			await seed('ItemF', [{ id: 'snapshot-2', category: 'SNAPSHOT' }]);
			const flushed = await postJSON('/Flush/', {});
			strictEqual(flushed.status, 200, 'flush control should succeed');
			ok(
				!rawIndexEntries('ItemF', 'category').some((e) => e.id === 'snapshot-2'),
				'a held checkpoint must not see a write that landed after it'
			);

			await refreshOracle();
			ok(snapshotPath !== firstSnapshot, 'each refresh must take a fresh checkpoint');
			ok(!existsSync(firstSnapshot), 'and must remove the one it replaces, so the SSTs it pins are bounded');
			ok(
				rawIndexEntries('ItemF', 'category').some((e) => e.id === 'snapshot-2'),
				'the fresh checkpoint must include it'
			);

			for (const id of ['snapshot-1', 'snapshot-2']) {
				const res = await postJSON('/DeleteOne/', { table: 'ItemF', id });
				strictEqual(res.status, 200, `cleanup delete of ${id} should succeed`);
			}
		});

		// Run against both tables: an audit:true control arm whose oracle has never been shown to
		// work on that table cannot be trusted to go red.
		for (const table of ['ItemF', 'ItemT']) {
			test(`oracle proof (${table}): sees a seeded index entry, and sees it vanish on a normal delete`, async () => {
				await seed(table, [{ id: 'proof-1', category: 'PROOF' }]);
				await refreshOracle();
				let entries = rawIndexEntries(table, 'category').filter((e) => e.key === 'PROOF');
				strictEqual(entries.length, 1, 'oracle should see exactly 1 raw index entry for PROOF after seed');
				strictEqual(entries[0].id, 'proof-1', 'raw index entry should point at proof-1');
				ok(await hasLiveRecord(table, 'proof-1'), 'proof-1 should be a live record after seed');

				const res = await postJSON('/DeleteOne/', { table, id: 'proof-1' });
				strictEqual(res.status, 200, 'ordinary delete should succeed');

				await refreshOracle();
				entries = rawIndexEntries(table, 'category').filter((e) => e.key === 'PROOF');
				strictEqual(entries.length, 0, 'oracle should see the PROOF index entry vanish after a normal delete');
				ok(!(await hasLiveRecord(table, 'proof-1')), 'proof-1 should no longer be a live record after a normal delete');
			});

			test(`oracle proof (${table}): detects an injected phantom that the join-based query surface cannot`, async () => {
				const res = await postJSON('/InjectPhantom/', { table, category: 'GHOST', id: 'ghost-1' });
				strictEqual(res.status, 200, 'InjectPhantom control should succeed (ghost-1 must not already exist)');

				await refreshOracle();
				ok(!(await hasLiveRecord(table, 'ghost-1')), 'ghost-1 should never have been written as a record');

				const phantoms = await findPhantoms(table, 'category');
				ok(
					phantoms.some((p) => p.id === 'ghost-1' && p.key === 'GHOST'),
					`oracle should detect the injected phantom (GHOST -> ghost-1); phantoms seen: ${JSON.stringify(phantoms)}`
				);

				const blind = await (await getJSON(`/BlindSearch/?table=${table}&category=GHOST`)).json();
				strictEqual(
					blind.hits.length,
					0,
					'the join-through-primary query surface must see 0 hits for the same phantom, which is why the arms below read raw storage'
				);

				// Remove the deliberate artifact so the table-wide scans in Arm A/B cannot report it as
				// a genuine phantom (or have a genuine one masked by it).
				const cleanup = await postJSON('/RemoveIndexEntry/', { table, category: 'GHOST', id: 'ghost-1' });
				strictEqual(cleanup.status, 200, 'positive-control cleanup should succeed');
				await refreshOracle();
				ok(
					(await findPhantoms(table, 'category')).every((p) => p.id !== 'ghost-1'),
					'ghost-1 phantom should be gone after cleanup'
				);
			});
		}

		// Arm A: the abort is fired by the long-transaction monitor mid-transaction, not by the
		// handler — a different path into the same commit branch than #1869's own test covers.
		for (const table of ['ItemF', 'ItemT']) {
			test(
				`Arm A (${table}): monitor-fired abort mid remove/insert/update rolls the delete back`,
				{ timeout: HOLD_MS + 60_000 },
				async () => {
					const removeId = `${table}-rm-base`;
					await seed(table, [
						{ id: '__seed__-0', category: '__seed__' },
						{ id: `${table}-upd-base`, category: 'ARMA-OLD' },
						{ id: removeId, category: 'ARMA-DEL' },
					]);

					// Without a live, indexed row to delete there is no removeEntry() call at all.
					await refreshOracle();
					ok(await hasLiveRecord(table, removeId), `${removeId} must exist before the held transaction deletes it`);
					ok(
						rawIndexEntries(table, 'category').some((e) => e.key === 'ARMA-DEL' && e.id === removeId),
						`${removeId} must be indexed before the held transaction deletes it`
					);

					const mark = markLogs();
					const res = await postJSON('/SlowMixedHold/', {
						table,
						insertIds: [
							{ id: `${table}-ins-1`, category: 'ARMA-NEW' },
							{ id: `${table}-ins-2`, category: 'ARMA-NEW' },
						],
						updateId: `${table}-upd-base`,
						updateCategory: 'ARMA-UPDATED',
						removeId,
						markerId: `${table}-marker`,
						holdMs: HOLD_MS,
					});
					const body = await res.text();
					// End-to-end proof that the transaction was really poisoned rather than merely logged
					// about: the request fails with the over-time error. A monitor that logged the abort
					// but left the handle usable would let the marker write and the commit succeed, and
					// this request would return 200.
					ok(
						res.status >= 400 && /exceeding the maximum open-transaction time/.test(body),
						`the held transaction must have been aborted, so its request must fail with the over-time error; got ${res.status} body=${body.slice(0, 400)}`
					);

					// The monitor's decision is asynchronous to the request returning, so wait for the
					// evidence itself rather than for a fixed settling delay.
					// The line names the table and the route it was started from, so the match is evidence
					// about THIS request rather than about any transaction that outran the 1 s limit.
					const aborted = new RegExp(
						`Transaction was open too long and has been aborted[^\\n]*from table: ${table}/ path: /SlowMixedHold/`
					);
					const logDeadline = Date.now() + 15_000;
					while (!sawLogSince(mark, aborted) && Date.now() < logDeadline) await sleep(250);
					ok(
						sawLogSince(mark, aborted),
						`the over-time monitor must have aborted this request's transaction; status=${res.status} body=${body.slice(0, 400)}`
					);

					await refreshOracle();
					const phantoms = await findPhantoms(table, 'category');
					const indexEntries = rawIndexEntries(table, 'category');
					// Whether the update landed depends on which side of the abort it fell on, so the check
					// is only that a surviving row is reachable through the index at all.
					const missing: string[] = [];
					for (const id of [`${table}-upd-base`, `${table}-ins-1`, `${table}-ins-2`]) {
						if (!(await hasLiveRecord(table, id))) continue;
						if (!indexEntries.some((ie) => ie.id === id)) missing.push(`${id} present in primary but not indexed`);
					}

					console.log(
						`\n[#1854 Arm A ${table}] status=${res.status}\n` +
							`  phantoms=${phantoms.length}${phantoms.length ? ' ' + JSON.stringify(phantoms) : ''}` +
							` missing=${missing.length}${missing.length ? ' ' + JSON.stringify(missing) : ''}` +
							` removeId-still-live=${await hasLiveRecord(table, removeId)}`
					);

					// `phantoms` alone would stay empty if the row and its index entry both vanished, which
					// is not something an aborted delete is allowed to do.
					ok(await hasLiveRecord(table, removeId), `Arm A (${table}): ${removeId} must survive the aborted delete`);
					ok(
						indexEntries.some((e) => e.key === 'ARMA-DEL' && e.id === removeId),
						`Arm A (${table}): ${removeId}'s index entry must survive the aborted delete`
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
			test(`Arm B (${table}): request-thrown abort after a delete rolls it back`, async () => {
				const id = `${table}-abort-1`;
				await seed(table, [{ id, category: 'ARMB' }]);

				// Both halves of the post-condition are equalities, so a seed that silently did nothing
				// would satisfy them with `false === false`.
				await refreshOracle();
				ok(await hasLiveRecord(table, id), `${id} must exist before the aborted delete`);
				ok(
					rawIndexEntries(table, 'category').some((e) => e.key === 'ARMB' && e.id === id),
					`${id} must be indexed before the aborted delete`
				);

				const res = await postJSON('/DeleteThenAbort/', { table, id });
				// Not just any error: the handler's own throw, so a 404 from a mis-registered route cannot
				// stand in for the abort this arm depends on.
				const abortBody = await res.text();
				ok(
					res.status >= 400 && abortBody.includes(`deliberate abort after delete (table=${table} id=${id})`),
					`DeleteThenAbort must surface its own deliberate throw; got ${res.status} body=${abortBody.slice(0, 400)}`
				);

				await refreshOracle();
				const primaryHasId = await hasLiveRecord(table, id);
				const indexHasEntry = rawIndexEntries(table, 'category').some((e) => e.key === 'ARMB' && e.id === id);

				console.log(
					`\n[#1854 Arm B ${table}] status=${res.status} primaryHasId=${primaryHasId} indexHasEntry=${indexHasEntry}`
				);

				ok(primaryHasId, `Arm B (${table}): ${id} must survive the aborted delete (the removal must roll back)`);
				ok(indexHasEntry, `Arm B (${table}): ${id}'s index entry must survive the aborted delete`);
				strictEqual(
					indexHasEntry,
					primaryHasId,
					`Arm B (${table}): base row and index entry must agree on whether id=${id} exists (primaryHasId=${primaryHasId}, indexHasEntry=${indexHasEntry})`
				);
			});
		}
	}
);
