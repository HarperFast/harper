/**
 * QA-769 — rewriting a DECLARED attribute's type over a typed-struct dictionary that already holds
 * records encoded under the old type. `count` outgrows `Int` and is widened to `Long`, and the
 * sibling `label` is widened from `String` to `Any`:
 *
 *   MeteredEvent { id: Int @primaryKey, count: Int @indexed,  label: String }
 *     ->          { id: Int @primaryKey, count: Long @indexed, label: Any }
 *
 * The change goes through the supported path — stop the instance, rewrite `schema.graphql`, start
 * again — not a live in-process mutation, and the instance runs `threads.count: 4` throughout so a
 * per-worker struct-dictionary divergence has somewhere to surface. `defineSuite` runs the whole
 * thing once per storage engine, because the record encoding under test is the engine's own.
 *
 * `integrationTests/database/indexed-numeric-range.test.ts` (QA-188) and
 * `bigint-indexed-range.test.ts` (QA-190) cover numeric range queries and the `Long` 2^53 ceiling on
 * a FIXED schema. What is new here is that the declared type changes underneath stored records:
 *
 *   1. precondition — the fixture really starts at `Int`/`String` with `count` indexed, and all four
 *      workers started, so neither the widening nor the cross-worker arm can pass vacuously.
 *   2. seeding — records under the OLD `Int`/`String` types, plus proof that 2^31 is loudly REJECTED
 *      before the widening (so its acceptance afterwards is a real change, not a pre-existing one).
 *   3. the widening — rewrite the INSTALLED schema copy, restart, and confirm `describe_table` now
 *      reports `Long`/`Any` with `count` still indexed.
 *   4. old-record fidelity — every seeded record reads back byte-identical, value AND type, through
 *      both REST and the ops-API `search_by_hash` path, and the two paths agree with each other.
 *   5. the widened type's new reach — 2^31 and 5e9 now round-trip; exactly 2^53 is accepted and
 *      2^53+2 rejected (Harper caps `Long` at abs(2^53) in `resources/tracked.ts:115` and
 *      `resources/Table.ts:6049`); genuine 64-bit magnitudes, handed in as real BigInt literals
 *      in-worker so no float64 transport rounds them first, reach that cap at full precision and are
 *      refused by it; and `label` now takes objects and numbers.
 *   6. index consistency — THE load-bearing arm, checked at both layers. The `@indexed count`
 *      secondary index must hold exactly the eleven value/primary-key entries the stored rows imply,
 *      spanning the old-encoded (id 1-6) and new-encoded (id 7-9, 30, 31) records, which is what
 *      "no phantom and no missing index entries" means literally; and the `greater_than` range query
 *      over it must return exactly the five rows above the threshold, in ascending order.
 *      Both are needed: `resources/search.ts:485` silently falls back to a full scan for an
 *      unindexed attribute, so the query result alone cannot show the index survived the widening,
 *      and the index dump alone cannot show the query planner reads it correctly.
 *   7. multi-worker + a second restart — every one of the four workers decodes the same
 *      old-encoded and new-encoded record identically (proven per worker, not assumed from a
 *      connection spray), and a restart with no schema change disturbs neither vintage.
 *
 * The schema rewrite targets `{dataRootDir}/components/{fixture}/schema.graphql`:
 * `setupHarperWithFixture` copies the fixture there, and that copy — not the source on disk — is
 * what Harper reloads. Every start re-passes the same options object, so the worker count and the
 * engine survive the restarts. `restart_service`/`restartHttpWorkers()` are never used against this
 * fixture: both are fire-and-forget and race the worker respawn, so each start polls the fixture's
 * own route instead.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/database/qa769-type-widening.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve, join, basename } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	type ContextWithHarper,
	type StartHarperOptions,
} from '@harperfast/integration-testing';
import { WORKER_COUNT, assertEveryWorkerStarted, NO_FULL_WORKER_COVERAGE } from './recordCachingWorkers.ts';
import { fetchOnNewConnection, observeEveryWorker } from '../utils/connectionPerRequest.ts';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'qa769-type-widening');
const FIXTURE_NAME = basename(FIXTURE_PATH);
const DATABASE = 'data';
const TABLE = 'MeteredEvent';

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;
const TWO31 = 2147483648; // first value that overflows Int
const TWO53 = 9007199254740992; // Harper's Long ceiling (resources/tracked.ts, resources/Table.ts)
const FIVE_BILLION = 5000000000;

const READY_TIMEOUT_MS = 120_000;
const RESTART_TEST_TIMEOUT_MS = 300_000;

// Rewritten onto the INSTALLED component copy mid-run to widen the declared types.
const SCHEMA_V2 = `type MeteredEvent @table @export {
	id: Int @primaryKey
	count: Long @indexed
	label: Any
}
`;

// Seeded while `count` is still Int and `label` still String, so every one of these is encoded under
// the OLD declared types before the widening.
const OLD_RECORDS = [
	{ id: 1, count: 0, label: 'zero' },
	{ id: 2, count: 1, label: 'one' },
	{ id: 3, count: -1, label: 'neg-one' },
	{ id: 4, count: INT32_MAX, label: 'int32-max' },
	{ id: 5, count: INT32_MIN, label: 'int32-min' },
	{ id: 6, count: 123456789, label: 'mid' },
];

const RANGE_THRESHOLD = 1000000;

// Exactly the rows above RANGE_THRESHOLD once the widened writes have landed, in ascending `count`
// order: two written under the old Int encoding (id 4, 6), three under the new Long encoding.
const ABOVE_THRESHOLD = [
	{ id: 6, count: 123456789 },
	{ id: 4, count: INT32_MAX },
	{ id: 7, count: TWO31 },
	{ id: 8, count: FIVE_BILLION },
	{ id: 9, count: TWO53 },
];

// Every id the suite expects to be stored by the time the index arm runs. The rejected writes
// (id 10, 20, 21) are absent, which is how a silently-accepted over-cap value would show up.
const STORED_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 31];

// The `count` secondary index's own entries, in its own order: ascending by indexed value, then by
// primary key. Old-encoded and new-encoded rows have to be interleaved here by value — an index that
// kept the two encodings in separate key spaces cannot produce this sequence.
const INDEX_ENTRIES = [
	{ count: INT32_MIN, id: 5 },
	{ count: -1, id: 3 },
	{ count: 0, id: 1 },
	{ count: 1, id: 2 },
	{ count: 1, id: 30 },
	{ count: 1, id: 31 },
	{ count: 123456789, id: 6 },
	{ count: INT32_MAX, id: 4 },
	{ count: TWO31, id: 7 },
	{ count: FIVE_BILLION, id: 8 },
	{ count: TWO53, id: 9 },
];

// Real 64-bit magnitudes, written in-worker as BigInt literals. `value` is the decimal Harper must
// echo back: seeing it un-rounded is the proof the bigint reached the range check without passing
// through a float64.
const BIGINT_PROBES = [
	{ id: 20, probe: '2^53+1', value: '9007199254740993' },
	{ id: 21, probe: '2^63-1', value: '9223372036854775807' },
];
const LONG_RANGE_MESSAGE = 'must be an integer (from -9007199254740992 to 9007199254740992)';

interface DumpedRow {
	id: number;
	count: number;
	countType: string;
	label: unknown;
	labelType: string;
}

interface WorkerRowView {
	threadId: number;
	count: number;
	countType: string;
	label: unknown;
	labelType: string;
}

/**
 * Compares only `expected`'s own fields, but strictly: `deepStrictEqual` separates 1 from '1' and a
 * number from a bigint, so a widened attribute that came back re-typed fails here rather than
 * needing a second typeof check beside every value check.
 */
function assertRow(actual: Record<string, unknown>, expected: Record<string, unknown>, label: string): void {
	deepStrictEqual(Object.fromEntries(Object.keys(expected).map((field) => [field, actual[field]])), expected, label);
}

function defineSuite(engine: 'rocksdb' | 'lmdb') {
	suite(
		`QA-769 declared-attribute type widening Int->Long/String->Any [${engine}]`,
		{ skip: process.platform === 'win32' },
		(ctx: ContextWithHarper) => {
			let client: ReturnType<typeof createApiClient>;
			// Re-passed unchanged on every restart; a fresh literal would silently drop the worker count
			// or the engine pin.
			const HARPER_OPTIONS: StartHarperOptions = {
				config: {
					threads: { count: WORKER_COUNT },
					storage: { engine },
					logging: { console: true, level: 'error' },
				},
				env: { HARPER_STORAGE_ENGINE: engine },
			};

			before(async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, HARPER_OPTIONS);
				await waitForFixture();
			});

			after(async () => {
				await teardownHarper(ctx);
			});

			/** A 200 from the fixture's own custom resource, so a half-loaded component is not mistaken for ready. */
			async function waitForFixture(): Promise<void> {
				client = createApiClient(ctx.harper);
				const deadline = Date.now() + READY_TIMEOUT_MS;
				while (Date.now() < deadline) {
					try {
						const probe = await client.reqRest('/DumpAll/').timeout(3000);
						if (probe.status === 200) return;
					} catch {
						/* not up yet, or mid-restart */
					}
					await sleep(250);
				}
				ok(false, `the fixture never served GET /DumpAll/ with 200 within ${READY_TIMEOUT_MS}ms — boot failed`);
			}

			function insert(records: Record<string, unknown>[]) {
				return client.req().send({ operation: 'insert', schema: DATABASE, table: TABLE, records }).timeout(30_000);
			}

			function restGet(id: number) {
				return client.reqRest(`/${TABLE}/${id}`).timeout(10_000);
			}

			/** The ops-API primary-key read path, which decodes the record independently of REST. */
			async function opsGet(id: number): Promise<Record<string, unknown>> {
				const response = await client
					.req()
					.send({
						operation: 'search_by_hash',
						schema: DATABASE,
						table: TABLE,
						hash_values: [id],
						get_attributes: ['id', 'count', 'label'],
					})
					.timeout(30_000)
					.expect(200);
				strictEqual(response.body.length, 1, `search_by_hash for id=${id} returned ${response.body.length} rows`);
				return response.body[0];
			}

			async function declaredTypes(): Promise<Record<string, unknown>> {
				const response = await client
					.req()
					.send({ operation: 'describe_table', database: DATABASE, table: TABLE })
					.timeout(30_000)
					.expect(200);
				return Object.fromEntries(
					response.body.attributes.map((attribute: any) => [
						attribute.attribute,
						{
							type: attribute.type,
							// A GraphQL `@indexed` records its (empty) argument set rather than `true`
							// (resources/graphql.ts:223), so the flag has to be read as a truthiness.
							indexed: Boolean(attribute.indexed),
							primaryKey: attribute.is_primary_key === true,
						},
					])
				);
			}

			async function rangeAboveThreshold(): Promise<Array<{ id: number; count: number }>> {
				const response = await client
					.req()
					.send({
						operation: 'search_by_conditions',
						schema: DATABASE,
						table: TABLE,
						operator: 'and',
						conditions: [{ search_attribute: 'count', search_type: 'greater_than', search_value: RANGE_THRESHOLD }],
						get_attributes: ['id', 'count'],
					})
					.timeout(30_000)
					.expect(200);
				return response.body.map((row: DumpedRow) => ({ id: row.id, count: row.count }));
			}

			async function indexEntries(): Promise<Array<{ count: number; id: number }>> {
				const response = await client.reqRest('/IndexDump/').timeout(30_000).expect(200);
				return response.body;
			}

			async function dumpAll(): Promise<DumpedRow[]> {
				const response = await client.reqRest('/DumpAll/').timeout(30_000).expect(200);
				return response.body;
			}

			function rowOnWorker(id: number): Promise<WorkerRowView> {
				return fetchOnNewConnection(`${ctx.harper.httpURL}/RowOnWorker/?id=${id}`, {
					headers: { Authorization: client.headers.Authorization },
				}).then(async (response) => {
					strictEqual(response.status, 200, `GET /RowOnWorker/?id=${id} => ${response.status}`);
					return response.json() as Promise<WorkerRowView>;
				});
			}

			test('precondition: the fixture starts at count:Int @indexed / label:String on all workers', async () => {
				await assertEveryWorkerStarted(ctx);
				deepStrictEqual(await declaredTypes(), {
					id: { type: 'Int', indexed: false, primaryKey: true },
					count: { type: 'Int', indexed: true, primaryKey: false },
					label: { type: 'String', indexed: false, primaryKey: false },
				});
			});

			test('seed: records land under the Int schema, and 2^31 is rejected before the widening', async () => {
				await insert(OLD_RECORDS).expect(200);

				const rejected = await insert([{ id: 7, count: TWO31, label: 'oversized-pre-widen' }]);
				ok(
					rejected.status >= 400,
					`writing 2^31 to a declared Int must be rejected, got ${rejected.status}: ${rejected.text}`
				);
				ok(/integer/i.test(rejected.text), `the rejection must name the type/range violation, got: ${rejected.text}`);
				// Loud rejection, not silent truncation: nothing may have been stored under that id.
				strictEqual((await restGet(7)).status, 404, 'the rejected pre-widening record must not have been stored');
			});

			test(
				'widen: rewriting schema.graphql and restarting re-declares count as Long and label as Any',
				{ timeout: RESTART_TEST_TIMEOUT_MS },
				async () => {
					await killHarper(ctx);
					await writeFile(
						join(ctx.harper.dataRootDir, 'components', FIXTURE_NAME, 'schema.graphql'),
						SCHEMA_V2,
						'utf8'
					);
					await startHarper(ctx, HARPER_OPTIONS);
					await waitForFixture();
					await assertEveryWorkerStarted(ctx);

					deepStrictEqual(await declaredTypes(), {
						id: { type: 'Int', indexed: false, primaryKey: true },
						count: { type: 'Long', indexed: true, primaryKey: false },
						label: { type: 'Any', indexed: false, primaryKey: false },
					});
				}
			);

			test('old-encoded records read back exact value and type through REST and search_by_hash', async () => {
				for (const record of OLD_RECORDS) {
					const rest = await restGet(record.id);
					strictEqual(rest.status, 200, `REST GET /${TABLE}/${record.id} => ${rest.status} post-widening`);
					const ops = await opsGet(record.id);

					const expected = { count: record.count, label: record.label };
					assertRow(rest.body, expected, `REST read of old-encoded id=${record.id} changed after the widening`);
					assertRow(ops, expected, `search_by_hash read of old-encoded id=${record.id} changed after the widening`);
					// A divergence between the two decode paths is its own finding, and neither comparison above
					// would catch it if both drifted to the same wrong value.
					assertRow(
						rest.body,
						{ count: ops.count, label: ops.label },
						`REST and search_by_hash disagree on old-encoded id=${record.id}`
					);
				}
			});

			test('the widened Long accepts what Int rejected, and round-trips it exactly', async () => {
				// Exactly the value and id the pre-widening seed arm saw rejected.
				await insert([{ id: 7, count: TWO31, label: 'now-fits-in-long' }]).expect(200);
				assertRow((await restGet(7)).body, { count: TWO31, label: 'now-fits-in-long' }, '2^31 did not round-trip');

				await insert([{ id: 8, count: FIVE_BILLION, label: 'five-billion' }]).expect(200);
				assertRow((await restGet(8)).body, { count: FIVE_BILLION, label: 'five-billion' }, '5e9 did not round-trip');
			});

			test("the widened Long still stops at Harper's own 2^53 ceiling", async () => {
				await insert([{ id: 9, count: TWO53, label: 'two-pow-53' }]).expect(200);
				assertRow((await restGet(9)).body, { count: TWO53, label: 'two-pow-53' }, '2^53 did not round-trip');

				// 2^53+2 is exactly representable as a float64 and strictly above the abs(2^53) cap both
				// resources/tracked.ts and resources/Table.ts enforce, so it must be rejected rather than
				// silently truncated to the ceiling.
				const rejected = await insert([{ id: 10, count: TWO53 + 2, label: 'over-cap' }]);
				ok(
					rejected.status >= 400,
					`2^53+2 exceeds the Long cap and must be rejected, got ${rejected.status}: ${rejected.text}`
				);
				strictEqual((await restGet(10)).status, 404, 'the over-cap record must not have been stored');
			});

			test('a genuine 64-bit magnitude reaches the Long range check un-rounded and is refused', async () => {
				for (const { id, probe, value } of BIGINT_PROBES) {
					const response = await fetch(`${ctx.harper.httpURL}/PutBigInt/`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
						body: JSON.stringify({ id, probe }),
					});
					const text = await response.text();
					strictEqual(response.status, 400, `BigInt probe ${probe} was not refused: ${response.status} ${text}`);
					// The echoed value is the load-bearing part: a float64 would have rounded 2^53+1 down to
					// 2^53 (which the Long cap ACCEPTS) long before the range check ran.
					const failure = JSON.parse(text);
					deepStrictEqual(
						{ code: failure.code, title: failure.title },
						{ code: 'ValidationError', title: `Value ${value} in property count ${LONG_RANGE_MESSAGE}` },
						`BigInt probe ${probe} was refused by something other than the Long range check: ${text}`
					);
					strictEqual((await restGet(id)).status, 404, `BigInt probe ${probe} stored a record despite failing`);
				}
			});

			test('the widened label:Any takes the objects and numbers String refused', async () => {
				const objectLabel = { foo: 1, arr: [1, 2, 3], nested: { ok: true } };
				await insert([{ id: 30, count: 1, label: objectLabel }]).expect(200);
				assertRow((await restGet(30)).body, { count: 1, label: objectLabel }, 'an object label did not round-trip');

				await insert([{ id: 31, count: 1, label: 12345 }]).expect(200);
				assertRow((await restGet(31)).body, { count: 1, label: 12345 }, 'a numeric label did not round-trip');
			});

			test('the widened @indexed attribute keeps one index spanning both encodings', async () => {
				// The index structure itself: exactly these value/primary-key pairs, no phantom entry and
				// none missing. This is also what proves `count` is still indexed at all — without it the
				// range query below would be satisfied by search.ts's silent full-scan fallback.
				deepStrictEqual(
					await indexEntries(),
					INDEX_ENTRIES,
					'the count index does not hold exactly the entries the stored rows imply'
				);

				// Exact row identity in the index's own result order: the five specific records, their exact
				// values, and ascending `count` across the encoding change.
				deepStrictEqual(
					await rangeAboveThreshold(),
					ABOVE_THRESHOLD,
					'the range query over the widened attribute did not return exactly the expected rows, in order'
				);

				// Index-independent oracle: the same predicate over a full base-table scan, so storage has to
				// agree with both layers above rather than all three sharing one wrong answer.
				const scan = await dumpAll();
				deepStrictEqual(
					scan.map((row) => row.id).sort((a, b) => a - b),
					STORED_IDS,
					'the table holds rows the suite did not store, or is missing rows it did'
				);
				deepStrictEqual(
					scan
						.filter((row) => row.count > RANGE_THRESHOLD)
						.map((row) => ({ id: row.id, count: row.count }))
						.sort((a, b) => a.count - b.count),
					ABOVE_THRESHOLD,
					'the full-table scan disagrees with the index about which rows are above the threshold'
				);
				for (const row of scan) {
					strictEqual(row.countType, 'number', `id=${row.id} decodes count as ${row.countType} in the worker`);
				}
			});

			test(
				'every worker decodes the old-encoded and new-encoded records identically',
				{ skip: NO_FULL_WORKER_COVERAGE },
				async () => {
					for (const { id, count, label } of [
						{ id: 4, count: INT32_MAX, label: 'int32-max' },
						{ id: 9, count: TWO53, label: 'two-pow-53' },
					]) {
						const views = await observeEveryWorker(
							() => rowOnWorker(id),
							(view) => view.threadId,
							{
								workerCount: WORKER_COUNT,
							}
						);
						const distinct = new Set(views.map((view) => JSON.stringify([view.count, view.countType, view.label])));
						deepStrictEqual(
							[...distinct],
							[JSON.stringify([count, 'number', label])],
							`the ${WORKER_COUNT} workers do not agree on id=${id} after the widening`
						);
					}
				}
			);

			test(
				'a second restart with no schema change disturbs neither old nor new records',
				{ timeout: RESTART_TEST_TIMEOUT_MS },
				async () => {
					await killHarper(ctx);
					await startHarper(ctx, HARPER_OPTIONS);
					await waitForFixture();
					await assertEveryWorkerStarted(ctx);

					deepStrictEqual(await declaredTypes(), {
						id: { type: 'Int', indexed: false, primaryKey: true },
						count: { type: 'Long', indexed: true, primaryKey: false },
						label: { type: 'Any', indexed: false, primaryKey: false },
					});

					for (const { id, count, label } of [
						{ id: 1, count: 0, label: 'zero' },
						{ id: 6, count: 123456789, label: 'mid' },
						{ id: 8, count: FIVE_BILLION, label: 'five-billion' },
						{ id: 9, count: TWO53, label: 'two-pow-53' },
					]) {
						const expected = { count, label };
						assertRow((await restGet(id)).body, expected, `REST read of id=${id} changed across the restart`);
						assertRow(await opsGet(id), expected, `search_by_hash read of id=${id} changed across the restart`);
					}

					// The index is opened afresh on this boot, so its entries are the other half of "nothing
					// was disturbed" and the only place a restart-time reindex would show.
					deepStrictEqual(await indexEntries(), INDEX_ENTRIES, 'the count index changed across the restart');
					deepStrictEqual(
						await rangeAboveThreshold(),
						ABOVE_THRESHOLD,
						'the widened range query changed across the restart'
					);
				}
			);
		}
	);
}

defineSuite('rocksdb');
defineSuite('lmdb');
