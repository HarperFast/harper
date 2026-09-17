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
 *   1. precondition — the engine in effect, four started workers, and a starting declaration of
 *      `Int`/`String` with `count` indexed.
 *   2. seeding — records under the OLD `Int`/`String` types, plus proof that 2^31 is loudly REJECTED
 *      before the widening (so its acceptance afterwards is a real change, not a pre-existing one).
 *   3. the widening — rewrite the INSTALLED schema copy, restart, and confirm `describe_table` now
 *      reports `Long`/`Any` with `count` still indexed.
 *   4. old-record fidelity — every seeded record reads back byte-identical, value AND type, through
 *      both REST and the ops-API `search_by_hash` path, each against the value it was written with.
 *   5. the widened type's new reach — 2^31 and 5e9 now round-trip; exactly 2^53 is accepted and 2^53+2
 *      rejected (Harper caps `Long` at abs(2^53) in `resources/tracked.ts`'s `Long` setter and in
 *      `resources/Table.ts`'s `Long` case); a real BigInt written in-worker, so no float64 transport
 *      rounds it first, is refused at any magnitude including an in-bounds 2^53, because that same
 *      case tests `typeof value !== 'number'` before the range; and `label` takes objects and numbers.
 *   6. index consistency, at both layers. The `@indexed count` secondary index must hold exactly the
 *      eleven value/primary-key entries the stored rows imply, old-encoded (id 1-6) and new-encoded
 *      (id 7-9, 30, 31) interleaved by value; and the `greater_than` range query over it must return
 *      exactly the five rows above the threshold, in ascending order. Both, because
 *      `resources/search.ts` answers a range query by full scan when an attribute has no usable index,
 *      so the query result alone does not show the index survived the widening, while the index dump
 *      alone does not show the planner reads it.
 *   7. multi-worker + a second restart — each of the four workers is asked individually, by thread
 *      id, for the same old-encoded and new-encoded record and must answer identically; and a restart
 *      with no schema change disturbs neither vintage nor the index.
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
import { NO_FULL_WORKER_COVERAGE, observedWorkerCount } from './recordCachingWorkers.ts';
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

// Fixed, not the shared HARPER_WORKER_COUNT knob: at one worker `observeEveryWorker` would be
// satisfied by a single response and the per-worker divergence this suite exists to catch would go
// unexercised while the suite stayed green.
const WORKER_COUNT = 4;

const READY_TIMEOUT_MS = 120_000;
const RESTART_TEST_TIMEOUT_MS = 300_000;

// Written over the INSTALLED component copy mid-run; the fixture source on disk is never touched.
const SCHEMA_V2 = `type MeteredEvent @table @export {
	id: Int @primaryKey
	count: Long @indexed
	label: Any
}
`;

// Encoded under the OLD declared types: seeded while `count` is still Int and `label` still String.
const OLD_RECORDS = [
	{ id: 1, count: 0, label: 'zero' },
	{ id: 2, count: 1, label: 'one' },
	{ id: 3, count: -1, label: 'neg-one' },
	{ id: 4, count: INT32_MAX, label: 'int32-max' },
	{ id: 5, count: INT32_MIN, label: 'int32-min' },
	{ id: 6, count: 123456789, label: 'mid' },
];

// Written under the widened `label: Any`, and rejected under the pre-widening `label: String`.
const OBJECT_LABEL = { foo: 1, arr: [1, 2, 3], nested: { ok: true } };

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

// Every stored id and the `typeof` its label decodes to in-worker. The rejected writes (10, 20, 21,
// 22, 40, 41) are absent, and only the two `label: Any` writes may have left `string`.
const STORED_LABEL_TYPES = new Map([
	[1, 'string'],
	[2, 'string'],
	[3, 'string'],
	[4, 'string'],
	[5, 'string'],
	[6, 'string'],
	[7, 'string'],
	[8, 'string'],
	[9, 'string'],
	[30, 'object'],
	[31, 'number'],
]);

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
// echo back un-rounded, which is the proof the bigint reached the range check without a float64.
const BIGINT_PROBES = [
	// In bounds for Long as a magnitude, so its refusal is what shows the gate is the JS type and not
	// the range; the other two are above the ceiling as well.
	{ id: 22, probe: '2^53', value: '9007199254740992' },
	{ id: 20, probe: '2^53+1', value: '9007199254740993' },
	{ id: 21, probe: '2^63-1', value: '9223372036854775807' },
];
// The one message `resources/Table.ts`'s `Long` case emits, for the type half and the range half alike.
const LONG_GUARD_MESSAGE = 'must be an integer (from -9007199254740992 to 9007199254740992)';

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
							// (`resources/graphql.ts`), so the flag has to be read as a truthiness.
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

			/** Loud at fewer than four workers, so the cross-worker arm cannot pass on a single one. */
			async function assertWorkersStarted(): Promise<void> {
				const observed = await observedWorkerCount(ctx);
				ok(
					observed >= WORKER_COUNT,
					`expected ${WORKER_COUNT} HTTP workers, observed ${observed} — the cross-worker arm would be vacuous`
				);
			}

			async function engineInEffect(): Promise<{ engine: string; primaryPath: string }> {
				const response = await client.reqRest('/StorageEngineInfo/').timeout(10_000).expect(200);
				return response.body;
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
				await assertWorkersStarted();
				const running = await engineInEffect();
				strictEqual(
					running.engine,
					engine,
					`PRECONDITION: this arm must run on ${engine}, got ${JSON.stringify(running)}`
				);
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
				strictEqual((await restGet(7)).status, 404, 'the rejected pre-widening record must not have been stored');

				// Both payload shapes the widened arm later accepts, so neither half of it can pass on a fixture
				// that shipped `label: Any` or a widening that only took effect for `count`.
				for (const [id, label] of [
					[40, OBJECT_LABEL],
					[41, 12345],
				] as const) {
					const rejectedLabel = await insert([{ id, count: 1, label }]);
					ok(
						rejectedLabel.status >= 400,
						`${typeof label} label under a declared String must be rejected, got ${rejectedLabel.status}: ${rejectedLabel.text}`
					);
					ok(
						/string/i.test(rejectedLabel.text),
						`the rejection must name the type violation, got: ${rejectedLabel.text}`
					);
					strictEqual(
						(await restGet(id)).status,
						404,
						`the rejected pre-widening label ${id} must not have been stored`
					);
				}
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
					await assertWorkersStarted();

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
				}
			});

			test('the widened Long accepts what Int rejected, and round-trips it exactly', async () => {
				// Exactly the value and id the pre-widening seed arm saw rejected.
				await insert([{ id: 7, count: TWO31, label: 'now-fits-in-long' }]).expect(200);
				assertRow(
					(await restGet(7).expect(200)).body,
					{ count: TWO31, label: 'now-fits-in-long' },
					'2^31 did not round-trip'
				);

				await insert([{ id: 8, count: FIVE_BILLION, label: 'five-billion' }]).expect(200);
				assertRow(
					(await restGet(8).expect(200)).body,
					{ count: FIVE_BILLION, label: 'five-billion' },
					'5e9 did not round-trip'
				);
			});

			test("the widened Long still stops at Harper's own 2^53 ceiling", async () => {
				await insert([{ id: 9, count: TWO53, label: 'two-pow-53' }]).expect(200);
				assertRow(
					(await restGet(9).expect(200)).body,
					{ count: TWO53, label: 'two-pow-53' },
					'2^53 did not round-trip'
				);

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

			test('the widened Long refuses a real BigInt whatever its magnitude, un-rounded', async () => {
				// Written in-worker as BigInt literals (the fixture's PutBigInt), so no float64 transport
				// rounds them before Harper sees them. `resources/Table.ts`'s `Long` case is a single
				// `typeof value !== 'number' || …range…` predicate behind one message, so the in-bounds 2^53
				// probe is refused by its type half: the widened Long holds JS numbers, not 64-bit integers.
				for (const { id, probe, value } of BIGINT_PROBES) {
					const response = await fetch(`${ctx.harper.httpURL}/PutBigInt/`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json', 'Authorization': client.headers.Authorization },
						body: JSON.stringify({ id, probe }),
					});
					const text = await response.text();
					strictEqual(response.status, 400, `BigInt probe ${probe} was not refused: ${response.status} ${text}`);
					// The echoed value is the load-bearing part: a float64 would have rounded 2^53+1 down to
					// 2^53, which the Long cap accepts, long before Harper saw it.
					const failure = JSON.parse(text);
					deepStrictEqual(
						{ code: failure.code, title: failure.title },
						{ code: 'ValidationError', title: `Value ${value} in property count ${LONG_GUARD_MESSAGE}` },
						`BigInt probe ${probe} was refused by something other than the Long type/range guard: ${text}`
					);
					strictEqual((await restGet(id)).status, 404, `BigInt probe ${probe} stored a record despite failing`);
				}
			});

			test('the widened label:Any takes the objects and numbers String refused', async () => {
				await insert([{ id: 30, count: 1, label: OBJECT_LABEL }]).expect(200);
				assertRow(
					(await restGet(30).expect(200)).body,
					{ count: 1, label: OBJECT_LABEL },
					'an object label did not round-trip'
				);

				await insert([{ id: 31, count: 1, label: 12345 }]).expect(200);
				assertRow(
					(await restGet(31).expect(200)).body,
					{ count: 1, label: 12345 },
					'a numeric label did not round-trip'
				);
			});

			test('the widened @indexed attribute keeps one index spanning both encodings', async () => {
				// The only layer that distinguishes a surviving index from `resources/search.ts`'s silent
				// full-scan fallback, which would answer the range query below either way.
				deepStrictEqual(
					await indexEntries(),
					INDEX_ENTRIES,
					'the count index does not hold exactly the entries the stored rows imply'
				);

				deepStrictEqual(
					await rangeAboveThreshold(),
					ABOVE_THRESHOLD,
					'the range query over the widened attribute did not return exactly the expected rows, in order'
				);

				// Index-independent oracle, so storage has to agree with both layers above rather than all three
				// sharing one wrong answer. An `Any` value handed back as a String fails on labelType.
				const scan = await dumpAll();
				deepStrictEqual(
					new Map(scan.map((row) => [row.id, row.labelType])),
					STORED_LABEL_TYPES,
					'the table does not hold exactly the rows the suite stored, with the label types it wrote'
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
					for (const { id, count, label, labelType } of [
						{ id: 4, count: INT32_MAX, label: 'int32-max', labelType: 'string' },
						{ id: 9, count: TWO53, label: 'two-pow-53', labelType: 'string' },
						{ id: 30, count: 1, label: OBJECT_LABEL, labelType: 'object' },
					]) {
						const views = await observeEveryWorker(
							() => rowOnWorker(id),
							(view) => view.threadId,
							{
								workerCount: WORKER_COUNT,
							}
						);
						const distinct = new Set(
							views.map((view) => JSON.stringify([view.count, view.countType, view.label, view.labelType]))
						);
						deepStrictEqual(
							[...distinct],
							[JSON.stringify([count, 'number', label, labelType])],
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
					await assertWorkersStarted();

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
						{ id: 30, count: 1, label: OBJECT_LABEL },
						{ id: 31, count: 1, label: 12345 },
					]) {
						const expected = { count, label };
						assertRow(
							(await restGet(id).expect(200)).body,
							expected,
							`REST read of id=${id} changed across the restart`
						);
						assertRow(await opsGet(id), expected, `search_by_hash read of id=${id} changed across the restart`);
					}

					// Opened afresh on this boot, so this is the only place a restart-time reindex would show.
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
