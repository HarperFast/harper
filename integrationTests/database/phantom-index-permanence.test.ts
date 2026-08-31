/**
 * A phantom secondary-index entry — an index key whose primary record does not exist — is
 * permanent, and it is never served.
 *
 * Two write paths used to create one and both are fixed — harper#1854 (an aborted `audit:false`
 * delete escaping its transaction) and harper#1989/#1894 (a removal re-adding a `[null, id]`
 * entry) — anchored by `integrationTests/resources/audit-false-delete-rollback.test.ts` and
 * `eviction-index-phantom-null-keys.test.ts` respectively. This file pins what happens to such an
 * entry if one ever exists again, which is a property of the entry rather than of either bug.
 *
 * Nothing reaps one. RocksDB compaction collapses superseded and tombstoned versions, and a
 * phantom is neither — it is a live key in the index column family, and compaction has no way to
 * know its primary is gone. A repeat `delete()` cannot repair it either: `updateIndices()`
 * derives both the old and the new indexed value from a record that is absent, so both resolve to
 * `undefined` and it `continue`s. Only `runIndexing()`, which clears the index before rebuilding,
 * removes one.
 *
 * What caps the severity is the read path: an index hit is materialized against the primary store
 * and dropped when no record comes back, so a phantom is never served. That masking is
 * conditional on the primary being absent rather than a blanket disregard of the raw index — the
 * control below injects the same kind of raw entry for an id that DOES exist, and every surface
 * then serves it under a value the record does not hold. Without that control, the zeros this
 * file asserts would also be satisfied by surfaces that had stopped reading the index at all.
 * The surfaces asserted are single-table `search()`, a two-table indexed read in one request
 * (harper#1881's shape), the ops-API `search_by_value`, and SQL; they converge on the same join.
 * A surface that reached the index without that join would not be covered here.
 *
 * Because both producers are fixed, the divergence is injected: the fixture writes the composite
 * index key straight through the table's own index store. The oracle is that same store read back
 * via `getRange()`, which is a raw composite-key scan with no primary join — `search_by_value`
 * is structurally blind here and cannot be used as one.
 *
 * RocksDB only: `flush()`, `compact()` and the RocksDB statistics the compaction proof reads are
 * RocksDB APIs, and LMDB has no on-disk sorted runs for a compaction to rewrite.
 *
 *   npm run test:integration -- "integrationTests/database/phantom-index-permanence.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'phantom-index-permanence');
const REQUEST_TIMEOUT = 20_000;

const PHANTOM_CATEGORY = 'phantom-category';
const PHANTOM_ID = 'phantom-1';
const LIVE_ID = 'live-1';
const STALE_CATEGORY = 'stale-category';
// Enough flushed waves to put the phantom in an SST with other files around it, and few enough to
// stay under RocksDB's default level0_file_num_compaction_trigger of 4.
const WAVES = 2;
const ROWS_PER_WAVE = 6;

interface IndexEntry {
	indexedValue: unknown;
	primaryKey: string;
}

suite(
	'phantom secondary-index entry permanence [rocksdb]',
	{ skip: process.platform === 'win32' },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let httpURL: string;
		let auth: string;

		async function post(path: string, body: unknown): Promise<any> {
			const response = await fetch(`${httpURL}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': auth },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT),
			});
			const text = await response.text();
			ok(response.ok, `POST ${path} must succeed; got ${response.status} ${text.slice(0, 300)}`);
			ok(text, `POST ${path} returned ${response.status} with an empty body`);
			return JSON.parse(text);
		}

		async function get(path: string): Promise<any> {
			const response = await fetch(`${httpURL}${path}`, {
				headers: { Authorization: auth },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT),
			});
			const text = await response.text();
			ok(response.ok, `GET ${path} must succeed; got ${response.status} ${text.slice(0, 300)}`);
			ok(text, `GET ${path} returned ${response.status} with an empty body`);
			return JSON.parse(text);
		}

		async function rawIndexKeysFor(category: string, table = 'Host'): Promise<string[]> {
			const entries: IndexEntry[] = await get(`/IndexDump/?table=${table}&category=${encodeURIComponent(category)}`);
			return entries.map((entry) => entry.primaryKey).sort();
		}

		async function comboSearchIds(order: string, category: string): Promise<Record<string, string[]>> {
			const result = await get(`/ComboSearch/?tables=${order}&category=${encodeURIComponent(category)}`);
			for (const name of Object.keys(result.results)) result.results[name].sort();
			return result.results;
		}

		async function searchByValueIds(category: string): Promise<string[]> {
			const response = await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: 'data',
					table: 'Host',
					search_attribute: 'category',
					search_value: category,
					get_attributes: ['id'],
				})
				.timeout(REQUEST_TIMEOUT);
			strictEqual(response.status, 200, `search_by_value must succeed; got ${response.status}`);
			ok(
				Array.isArray(response.body),
				`search_by_value must return an array of rows, or the "no hits" assertions below pass vacuously; got ${typeof response.body}`
			);
			return response.body.map((row: any) => row.id).sort();
		}

		async function sqlIds(category: string): Promise<string[]> {
			const response = await client
				.req()
				.send({ operation: 'sql', sql: `SELECT id FROM data.Host WHERE category = '${category}'` })
				.timeout(REQUEST_TIMEOUT);
			strictEqual(response.status, 200, `SQL select must succeed; got ${response.status}`);
			ok(Array.isArray(response.body), `SQL select must return rows; got ${typeof response.body}`);
			return response.body.map((row: any) => row.id).sort();
		}

		/** Every enumerated index-backed read surface, for one indexed value. Companion never holds a
		 * row under any category this suite queries, so its side of each cross-table read is asserted
		 * empty here — a phantom leaking across tables would otherwise go unnoticed. */
		async function allReadSurfaces(category: string): Promise<Record<string, string[]>> {
			const companionFirst = await comboSearchIds('Companion,Host', category);
			const hostFirst = await comboSearchIds('Host,Companion', category);
			for (const [order, results] of [
				['Companion,Host', companionFirst],
				['Host,Companion', hostFirst],
			] as const) {
				deepStrictEqual(results.Companion, [], `${order}: Companion must never match category "${category}"`);
			}
			return {
				search: (await comboSearchIds('Host', category)).Host,
				comboCompanionFirst: companionFirst.Host,
				comboHostFirst: hostFirst.Host,
				searchByValue: await searchByValueIds(category),
				sql: await sqlIds(category),
			};
		}

		function assertEverySurface(surfaces: Record<string, string[]>, expected: string[], context: string): void {
			for (const [name, ids] of Object.entries(surfaces)) {
				deepStrictEqual(ids, expected, `${context}: ${name} must return exactly ${JSON.stringify(expected)}`);
			}
		}

		before(
			async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, {
					// One worker, so the flush/compact/index-dump calls and the read surfaces are
					// structurally the same process rather than incidentally so.
					config: { threads: { count: 1 }, logging: { console: true, level: 'error' } },
					env: { HARPER_STORAGE_ENGINE: 'rocksdb' },
				});
				client = createApiClient(ctx.harper);
				httpURL = ctx.harper.httpURL;
				auth = client.headers.Authorization;

				const deadline = Date.now() + 120_000;
				let ready = false;
				let lastProbeFailure = 'no attempt completed';
				while (!ready && Date.now() < deadline) {
					try {
						const probe = await fetch(`${httpURL}/Probe/`, {
							headers: { Authorization: auth },
							signal: AbortSignal.timeout(2000),
						});
						// An unconsumed undici body holds its socket out of the pool for the whole poll.
						await probe.text();
						ready = probe.status === 200;
						if (!ready) lastProbeFailure = `HTTP ${probe.status}`;
					} catch (error) {
						// Carried into the failure message: a malformed httpURL throws every iteration and
						// would otherwise read as a plain registration timeout.
						lastProbeFailure = String(error);
					}
					if (!ready) await sleep(250);
				}
				ok(ready, `fixture routes never became ready; last probe result: ${lastProbeFailure}`);

				for (let wave = 0; wave < WAVES; wave++) {
					for (const table of ['Host', 'Companion']) {
						const rows = Array.from({ length: ROWS_PER_WAVE }, (_, i) => ({
							id: `${table.toLowerCase()}-${wave}-${i}`,
							category: `bulk-${wave}`,
							value: `wave ${wave}`,
						}));
						await post('/Seed/', { table, rows });
					}
					// Inject before the last flush so the phantom is sealed into an SST and is therefore
					// data that the compaction below actually has to rewrite.
					if (wave === WAVES - 1) await post('/InjectPhantom/', { category: PHANTOM_CATEGORY, id: PHANTOM_ID });
					await post('/FlushAndStats/', { table: 'Host' });
					await post('/FlushAndStats/', { table: 'Companion' });
				}
			},
			{ timeout: 300_000 }
		);

		after(
			async () => {
				await teardownHarper(ctx);
			},
			{ timeout: 60_000 }
		);

		test('the table is backed by the RocksDB index store', { timeout: 60_000 }, async () => {
			const info = await get('/EngineInfo/?table=Host');
			strictEqual(
				info.indexStoreClass,
				'RocksIndexStore',
				`this suite's flush/compact/statistics machinery is RocksDB-only, but the category index is a ${info.indexStoreClass}`
			);
		});

		test(
			'the injected phantom is visible to the raw index oracle and to no read surface',
			{ timeout: 60_000 },
			async () => {
				deepStrictEqual(
					await rawIndexKeysFor(PHANTOM_CATEGORY),
					[PHANTOM_ID],
					'the raw index store must hold the injected entry — otherwise every "not served" assertion below is vacuous'
				);
				strictEqual(
					(await get(`/PrimaryHas/?table=Host&id=${PHANTOM_ID}`)).present,
					false,
					'the injected id must have no primary record, or it is not a phantom'
				);

				assertEverySurface(await allReadSurfaces(PHANTOM_CATEGORY), [], 'phantom alone');
			}
		);

		test('a live row under the same category is served, and only it', { timeout: 60_000 }, async () => {
			await post('/Seed/', { table: 'Host', rows: [{ id: LIVE_ID, category: PHANTOM_CATEGORY, value: 'live' }] });

			deepStrictEqual(
				await rawIndexKeysFor(PHANTOM_CATEGORY),
				[LIVE_ID, PHANTOM_ID].sort(),
				'the raw index must now hold both the live entry and the phantom'
			);
			assertEverySurface(await allReadSurfaces(PHANTOM_CATEGORY), [LIVE_ID], 'phantom beside a live row');
		});

		test(
			'the phantom is dropped because its primary record is absent, not because the surfaces ignore the raw index',
			{ timeout: 60_000 },
			async () => {
				await post('/InjectStaleEntry/', { category: STALE_CATEGORY, id: LIVE_ID });

				deepStrictEqual(await rawIndexKeysFor(STALE_CATEGORY), [LIVE_ID], 'the raw index must hold the stale entry');
				assertEverySurface(
					await allReadSurfaces(STALE_CATEGORY),
					[LIVE_ID],
					'an index entry under a value the record does not hold is served when the primary record exists'
				);
			}
		);

		test('the phantom survives an explicit compaction of its index column family', { timeout: 60_000 }, async () => {
			await post('/FlushAndStats/', { table: 'Host' });
			const { before, after } = await post('/CompactAndStats/', { table: 'Host' });
			deepStrictEqual(
				[...before.errors, ...after.errors],
				[],
				'RocksDB statistics must be readable on both sides of the compaction'
			);

			// Proven by bytes actually rewritten rather than by a drop in sorted runs: with data this
			// small RocksDB's own background compaction can collapse the runs first, which would fail a
			// run-count proof for a reason that has nothing to do with the phantom.
			ok(
				after.compactWriteBytes > before.compactWriteBytes,
				`compact() must have rewritten data: rocksdb.compact.write.bytes ${before.compactWriteBytes} -> ` +
					`${after.compactWriteBytes} (sorted runs ${before.totalSortedRuns} -> ${after.totalSortedRuns})`
			);

			deepStrictEqual(
				await rawIndexKeysFor(PHANTOM_CATEGORY),
				[LIVE_ID, PHANTOM_ID].sort(),
				'compaction must not reap the phantom: it is a live index key, not a tombstone'
			);
		});

		test('a repeat delete() of the phantom id is a no-op', { timeout: 60_000 }, async () => {
			await post('/DeleteOne/', { table: 'Host', id: PHANTOM_ID });

			deepStrictEqual(
				await rawIndexKeysFor(PHANTOM_CATEGORY),
				[LIVE_ID, PHANTOM_ID].sort(),
				'delete() derives index removals from the absent primary record, so it cannot remove the phantom'
			);
		});

		test('no read surface serves the phantom after compaction and the repeat delete', { timeout: 60_000 }, async () => {
			assertEverySurface(await allReadSurfaces(PHANTOM_CATEGORY), [LIVE_ID], 'after compaction and repeat delete');
		});
	}
);
