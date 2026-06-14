/**
 * HNSW vector-index data-integrity integration tests.
 *
 * Guards the six data-integrity fixes landed in commit 251e5b73
 * (fix(hnsw): six data-integrity fixes for HNSW vector index (5.1 GA)).
 *
 * Unlike the unit tests in unitTests/resources/vectorIndex.test.js (which run on
 * a mock in-memory store), these tests exercise the FULL stack: schema-defined
 * HNSW table, real RocksDB storage, real Table.search() query path.
 *
 * Tests:
 *  1. Delete-entry-point survival — bulk-delete including the entry-point node
 *     leaves every surviving record reachable via vector search.
 *     Pre-fix: search() returned [] while records remained.
 *
 *  2. Update-churn reachability — repeatedly updating each record's vector
 *     (re-embed pattern) must not cause records to gradually lose inbound edges
 *     and vanish from search results.
 *     Pre-fix: reverse-edge sweep was too broad, accumulating asymmetry.
 *
 *  3. Threshold queries (le/lt) through the real query path — le boundary is
 *     inclusive, le with value 0 returns only exact-zero-distance matches.
 *     Pre-fix: le used strict < instead of <=.
 *
 *  4. Reindex over existing data — populate a table without the HNSW index,
 *     then alter the schema to add it so runIndexing backfills existing records;
 *     all records must be searchable after backfill. Then verify that post-
 *     backfill updates and deletes also work.
 *
 * Vector search is exercised via the HTTP QUERY method (RFC-draft, supported by
 * Harper's REST layer) with a JSON body, which flows into Table.search() without
 * the mapCondition stripping done by search_by_conditions. The body shape is:
 *   { sort: { attribute: <attr>, target: <vector>, distance: 'cosine' } }
 * or for threshold queries:
 *   { conditions: [{ attribute: <attr>, comparator: 'le', value: <n>, target: <vector> }] }
 *
 * Related PR: HarperFast/harper#1234
 * Related fixes: commit 251e5b73 (fix(hnsw): six data-integrity fixes)
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error no type declarations on .mjs utils
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error no type declarations on .mjs utils
import { restartHttpWorkers } from '../apiTests/utils/lifecycle.mjs';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/** Schema WITH HNSW index on the embedding attribute. */
function makeSchemaWithIndex(typeName: string, database: string): string {
	return [
		`type ${typeName} @table(database: "${database}") @sealed @export {`,
		'\tid: ID! @primaryKey',
		'\ttag: String',
		'\tembedding: [Float] @indexed(type: "HNSW", distance: "cosine")',
		'}',
		'',
	].join('\n');
}

/** Schema WITHOUT any index on the embedding attribute (pre-backfill state). */
function makeSchemaWithoutIndex(typeName: string, database: string): string {
	return [
		`type ${typeName} @table(database: "${database}") @sealed @export {`,
		'\tid: ID! @primaryKey',
		'\ttag: String',
		'\tembedding: [Float]',
		'}',
		'',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic unit vector seeded by an integer.
 * Uses a simple LCG so tests are reproducible across runs.
 */
function seedVector(seed: number, dims: number = 8): number[] {
	let s = (seed * 1664525 + 1013904223) >>> 0;
	const rand = (): number => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
	const v: number[] = [];
	let mag = 0;
	for (let i = 0; i < dims; i++) {
		const x = rand() * 2 - 1;
		v.push(x);
		mag += x * x;
	}
	const inv = 1 / (Math.sqrt(mag) || 1);
	return v.map((x) => x * inv);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Execute a vector sort search via the HTTP QUERY method.
 * Returns an array of records sorted by ascending cosine distance.
 *
 * The HTTP QUERY method routes into Resource.static.query → Table.search(body),
 * bypassing the operations-API mapCondition that strips `target` from conditions.
 */
async function vectorSearch(
	httpURL: string,
	headers: Record<string, string>,
	resourcePath: string,
	target: number[],
	opts: { limit?: number; select?: string[] } = {}
): Promise<any[]> {
	const body: any = {
		sort: { attribute: 'embedding', target, distance: 'cosine' },
	};
	if (opts.limit !== undefined) body.limit = opts.limit;
	if (opts.select !== undefined) body.select = opts.select;
	return queryResource(httpURL, headers, resourcePath, body);
}

/**
 * Issue an HTTP QUERY request via fetch — supertest/superagent has no API for
 * non-standard verbs, while undici's fetch passes custom method tokens through.
 */
async function queryResource(
	httpURL: string,
	headers: Record<string, string>,
	resourcePath: string,
	body: any
): Promise<any[]> {
	const resp = await fetch(`${httpURL}${resourcePath}`, {
		method: 'QUERY',
		headers: { ...headers, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await resp.text();
	if (resp.status !== 200) {
		throw new Error(`QUERY ${resourcePath} returned ${resp.status}: ${text}`);
	}
	const data = JSON.parse(text);
	return Array.isArray(data) ? data : [];
}

/**
 * Execute a threshold query (le/lt comparator) via the HTTP QUERY method.
 *
 * The `target` vector is carried on the condition object. Reaching Table.search()
 * directly through the QUERY body preserves it; the operations-API
 * search_by_conditions path would strip it via mapCondition.
 */
async function vectorThresholdSearch(
	httpURL: string,
	headers: Record<string, string>,
	resourcePath: string,
	target: number[],
	comparator: 'le' | 'lt',
	value: number
): Promise<any[]> {
	const body = {
		conditions: [{ attribute: 'embedding', comparator, value, target }],
	};
	return queryResource(httpURL, headers, resourcePath, body);
}

/** POST a record to the REST endpoint. */
async function insertRecord(
	httpURL: string,
	headers: Record<string, string>,
	path: string,
	record: any
): Promise<void> {
	const resp = await request(httpURL).post(path).set(headers).send(record);
	ok([200, 201, 204].includes(resp.status), `POST ${path} returned ${resp.status}: ${JSON.stringify(resp.body)}`);
}

/** PUT (full-record update) via REST. */
async function updateRecord(
	httpURL: string,
	headers: Record<string, string>,
	path: string,
	id: string | number,
	record: any
): Promise<void> {
	const resp = await request(httpURL)
		.put(`${path}${id}`)
		.set(headers)
		.send({ id, ...record });
	ok([200, 201, 204].includes(resp.status), `PUT ${path}${id} returned ${resp.status}: ${JSON.stringify(resp.body)}`);
}

/** DELETE a record via REST. */
async function deleteRecord(
	httpURL: string,
	headers: Record<string, string>,
	path: string,
	id: string | number
): Promise<void> {
	const resp = await request(httpURL).delete(`${path}${id}`).set(headers);
	ok([200, 204].includes(resp.status), `DELETE ${path}${id} returned ${resp.status}: ${JSON.stringify(resp.body)}`);
}

/**
 * Poll `predicate()` until it resolves true or `timeoutMs` elapses.
 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 60_000, intervalMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(intervalMs);
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('HNSW vector-index data-integrity (integration)', (ctx: ContextWithHarper) => {
	let client: any;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ── Test 1: Delete-entry-point survival ─────────────────────────────────
	test('delete-entry-point: bulk-delete including entry point leaves survivors findable', async () => {
		// Guards fix #2: entry-point replacement scan now passes the transaction to
		// getRange and skips the node being deleted.
		// Pre-fix: getRange ran outside the write-set → re-elected the deleted node
		// as EP → dangling entry point → subsequent searches returned [].
		const DB = 'vecinteg1';
		const TABLE = 'DelEPTable';
		const PROJECT = 'vecintegsuite1';
		const DIMS = 8;
		const N = 50;
		const SURVIVORS = 10;
		const deleteCount = N - SURVIVORS;

		await client
			.req()
			.send({ operation: 'add_component', project: PROJECT })
			.expect((r: any) => {
				ok(
					JSON.stringify(r.body).includes('Successfully added project') ||
						JSON.stringify(r.body).includes('Project already exists'),
					r.text
				);
			});
		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: PROJECT,
				file: 'schema.graphql',
				payload: makeSchemaWithIndex(TABLE, DB),
			})
			.expect(200);

		await restartHttpWorkers(client, `/${TABLE}/`);

		const httpURL = ctx.harper.httpURL;
		const headers = client.headers;
		const path = `/${TABLE}/`;

		// Insert N records — the first-inserted node becomes the initial entry point.
		for (let i = 0; i < N; i++) {
			await insertRecord(httpURL, headers, path, { id: `ep-${i}`, embedding: seedVector(i, DIMS) });
		}

		// Delete first (N − SURVIVORS) records. Very likely to include the EP
		// (first-inserted node is elected EP on small graphs and rarely displaced).
		for (let i = 0; i < deleteCount; i++) {
			await deleteRecord(httpURL, headers, path, `ep-${i}`);
		}

		// Every surviving record must be reachable.
		const queryVec = seedVector(N + 1, DIMS);
		const results = await vectorSearch(httpURL, headers, path, queryVec, { limit: SURVIVORS + 5 });
		const resultIds = new Set(results.map((r: any) => r.id));

		for (let i = 0; i < deleteCount; i++) {
			ok(!resultIds.has(`ep-${i}`), `deleted record ep-${i} must not appear in results`);
		}

		let unreachable = 0;
		for (let i = deleteCount; i < N; i++) {
			if (!resultIds.has(`ep-${i}`)) unreachable++;
		}
		// Allow at most 1 HNSW-approximate miss on a 10-survivor graph.
		ok(
			unreachable <= 1,
			`expected all ${SURVIVORS} survivors reachable; ${unreachable} missing. found: ${JSON.stringify([...resultIds])}`
		);
	});

	// ── Test 2: Update-churn reachability ────────────────────────────────────
	test('update-churn: repeated vector updates preserve full reachability', async () => {
		// Guards fix #3: UPDATE path now removes reverse edge only at the exact level l
		// where the old connection existed, not the full 0..l sweep (correct for DELETE).
		// The broader sweep destroyed reverse edges that addConnection had just re-added,
		// accumulating asymmetry with every re-embed round.
		const DB = 'vecinteg2';
		const TABLE = 'ChurnTable';
		const PROJECT = 'vecintegsuite2';
		const DIMS = 8;
		const N = 30;
		const ROUNDS = 5;

		await client
			.req()
			.send({ operation: 'add_component', project: PROJECT })
			.expect((r: any) => {
				ok(
					JSON.stringify(r.body).includes('Successfully added project') ||
						JSON.stringify(r.body).includes('Project already exists'),
					r.text
				);
			});
		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: PROJECT,
				file: 'schema.graphql',
				payload: makeSchemaWithIndex(TABLE, DB),
			})
			.expect(200);

		await restartHttpWorkers(client, `/${TABLE}/`);

		const httpURL = ctx.harper.httpURL;
		const headers = client.headers;
		const path = `/${TABLE}/`;

		for (let i = 0; i < N; i++) {
			await insertRecord(httpURL, headers, path, { id: `churn-${i}`, embedding: seedVector(i, DIMS) });
		}

		// Churn: update every record's vector ROUNDS times with different seeds.
		for (let round = 0; round < ROUNDS; round++) {
			for (let i = 0; i < N; i++) {
				await updateRecord(httpURL, headers, path, `churn-${i}`, {
					embedding: seedVector(i * 100 + round + 1, DIMS),
					tag: `r${round}`,
				});
			}
		}

		// Each record's final vector is seedVector(i*100 + ROUNDS, dims).
		// Searching for that exact vector must return it in the top-5.
		let misses = 0;
		for (let i = 0; i < N; i++) {
			const finalVec = seedVector(i * 100 + ROUNDS, DIMS);
			const results = await vectorSearch(httpURL, headers, path, finalVec, { limit: 5 });
			if (!results.some((r: any) => r.id === `churn-${i}`)) misses++;
		}
		const allowed = Math.ceil(N * 0.1);
		ok(misses <= allowed, `expected ≤${allowed} misses after ${ROUNDS} churn rounds; got ${misses}/${N}`);
	});

	// ── Test 3: Threshold queries (le/lt) ────────────────────────────────────
	test('threshold queries: le includes exact boundary; le(~0) returns exact-match only', async () => {
		// Guards fix #6b: le comparator now uses <= (was <).
		// Pre-fix: records at exactly the threshold distance were excluded by le.
		const DB = 'vecinteg3';
		const TABLE = 'ThreshTable';
		const PROJECT = 'vecintegsuite3';

		await client
			.req()
			.send({ operation: 'add_component', project: PROJECT })
			.expect((r: any) => {
				ok(
					JSON.stringify(r.body).includes('Successfully added project') ||
						JSON.stringify(r.body).includes('Project already exists'),
					r.text
				);
			});
		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: PROJECT,
				file: 'schema.graphql',
				payload: makeSchemaWithIndex(TABLE, DB),
			})
			.expect(200);

		await restartHttpWorkers(client, `/${TABLE}/`);

		const httpURL = ctx.harper.httpURL;
		const headers = client.headers;
		const path = `/${TABLE}/`;

		// 2-D vectors at three well-separated cosine distances from [1,0]:
		//   [1,0]            → distance 0      (exact; representable in float32, so exactly 0)
		//   [1/√2, 1/√2]    → distance ≈0.293 (near)
		//   [0,1]            → distance 1      (far)
		// Vectors are STORED as float32, so a float64 prediction of the near distance
		// differs from the server's computed value at ~1e-8. Boundary assertions must
		// therefore use the server's own $distance values, not locally computed ones.
		const INV_SQRT2 = 1 / Math.sqrt(2);
		const target = [1, 0];

		await insertRecord(httpURL, headers, path, { id: 'exact', embedding: [1, 0] });
		await insertRecord(httpURL, headers, path, { id: 'near', embedding: [INV_SQRT2, INV_SQRT2] });
		await insertRecord(httpURL, headers, path, { id: 'far', embedding: [0, 1] });

		// Fetch the actual stored distances; these are the exact values the threshold
		// filter compares against (same candidate-distance computation, no rerank on
		// a non-quantized index).
		const ranked = await vectorSearch(httpURL, headers, path, target, { select: ['id', '$distance'] });
		const distanceOf = (id: string) => {
			const rec = ranked.find((r: any) => r.id === id);
			ok(rec && typeof rec.$distance === 'number', `expected $distance for '${id}', got ${JSON.stringify(rec)}`);
			return rec.$distance as number;
		};
		const dExact = distanceOf('exact');
		const dNear = distanceOf('near');
		strictEqual(dExact, 0, `[1,0] is float32-representable; self-distance must be exactly 0, got ${dExact}`);

		// le(dNear) must include both "exact" (dist < boundary) and "near"
		// (dist == boundary — this is the <= fix).
		const leNear = await vectorThresholdSearch(httpURL, headers, path, target, 'le', dNear);
		const leNearIds = new Set(leNear.map((r: any) => r.id));
		ok(leNearIds.has('exact'), `le(dNear) must include 'exact' (0 ≤ ${dNear})`);
		ok(leNearIds.has('near'), `le(dNear) must include 'near' at exact boundary distance ${dNear}`);
		ok(!leNearIds.has('far'), `le(dNear) must not include 'far' (distance 1 > ${dNear})`);

		// lt(dNear) must include "exact" but NOT "near" (strict).
		const ltNear = await vectorThresholdSearch(httpURL, headers, path, target, 'lt', dNear);
		const ltNearIds = new Set(ltNear.map((r: any) => r.id));
		ok(ltNearIds.has('exact'), `lt(dNear) must include 'exact' (0 < ${dNear})`);
		ok(!ltNearIds.has('near'), `lt(dNear) must NOT include 'near' at boundary (strict less-than)`);

		// le(0) must return only the exact-match record. Pre-fix falsy-0 issue: a truthy
		// guard (if (limit)) skipped the filter entirely for a threshold of 0, returning
		// every record. dExact is exactly 0, so this exercises the real boundary.
		const leZero = await vectorThresholdSearch(httpURL, headers, path, target, 'le', dExact);
		const leZeroIds = new Set(leZero.map((r: any) => r.id));
		ok(leZeroIds.has('exact'), `le(0) must include the exact-match record`);
		ok(
			!leZeroIds.has('near') && !leZeroIds.has('far'),
			`le(0) must return only the exact match; got ${JSON.stringify([...leZeroIds])}`
		);
	});

	// ── Test 4: Reindex over existing data ──────────────────────────────────
	test('reindex backfill: adding HNSW index to populated table makes all records searchable', async () => {
		// Guards fix #4 (backfill-resume idempotency) and fix #5 (lastIndexedKey reset
		// on structural index change so runIndexing starts clean).
		const DB = 'vecinteg4';
		const TABLE = 'ReindexTable';
		const PROJECT = 'vecintegsuite4';
		const DIMS = 8;
		const N = 40;

		// Step 1: Deploy schema WITHOUT the HNSW index.
		await client
			.req()
			.send({ operation: 'add_component', project: PROJECT })
			.expect((r: any) => {
				ok(
					JSON.stringify(r.body).includes('Successfully added project') ||
						JSON.stringify(r.body).includes('Project already exists'),
					r.text
				);
			});
		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: PROJECT,
				file: 'schema.graphql',
				payload: makeSchemaWithoutIndex(TABLE, DB),
			})
			.expect(200);

		await restartHttpWorkers(client, `/${TABLE}/`);

		const httpURL = ctx.harper.httpURL;
		const headers = client.headers;
		const path = `/${TABLE}/`;

		// Step 2: Insert N records (plain [Float], no HNSW index yet).
		for (let i = 0; i < N; i++) {
			await insertRecord(httpURL, headers, path, { id: `reindex-${i}`, embedding: seedVector(i, DIMS) });
		}

		// Sanity-check: records exist.
		const hashCheck = await client
			.req()
			.send({
				operation: 'search_by_hash',
				database: DB,
				table: TABLE,
				hash_values: ['reindex-0'],
				get_attributes: ['id'],
			})
			.expect(200);
		ok(Array.isArray(hashCheck.body) && hashCheck.body.length === 1, 'reindex-0 must exist before reindex');

		// Step 3: Alter schema to ADD the HNSW index → triggers runIndexing backfill.
		await client
			.req()
			.send({
				operation: 'set_component_file',
				project: PROJECT,
				file: 'schema.graphql',
				payload: makeSchemaWithIndex(TABLE, DB),
			})
			.expect(200);

		await restartHttpWorkers(client, `/${TABLE}/`);

		// Step 4: Poll until backfill completes (search returns results).
		// During indexing the HNSW index has isIndexing=true and searches return 503.
		await waitFor(async () => {
			try {
				const results = await vectorSearch(httpURL, headers, path, seedVector(0, DIMS), { limit: 5 });
				return results.length > 0;
			} catch {
				return false;
			}
		}, 60_000);

		// Step 5: All N pre-existing records must be reachable.
		let misses = 0;
		for (let i = 0; i < N; i++) {
			const vec = seedVector(i, DIMS);
			const results = await vectorSearch(httpURL, headers, path, vec, { limit: 5 });
			if (!results.some((r: any) => r.id === `reindex-${i}`)) misses++;
		}
		const allowed = Math.ceil(N * 0.1);
		ok(misses <= allowed, `expected ≤${allowed} misses after backfill; got ${misses}/${N}`);

		// Step 6: Post-backfill mutations must work correctly.
		for (let i = 0; i < 5; i++) {
			await updateRecord(httpURL, headers, path, `reindex-${i}`, {
				embedding: seedVector(i + 1000, DIMS),
				tag: 'updated',
			});
		}
		for (let i = 5; i < 10; i++) {
			await deleteRecord(httpURL, headers, path, `reindex-${i}`);
		}

		// reindex-0's new vector (seed 1000) must be near the top; deleted records absent.
		const updatedVec = seedVector(1000, DIMS);
		const afterResults = await vectorSearch(httpURL, headers, path, updatedVec, { limit: 15 });
		const afterIds = new Set(afterResults.map((r: any) => r.id));

		ok(afterIds.has('reindex-0'), 'updated reindex-0 must appear near its new vector');
		for (let i = 5; i < 10; i++) {
			ok(!afterIds.has(`reindex-${i}`), `deleted reindex-${i} must not appear in search results`);
		}

		// Note on interrupted-backfill-then-restart:
		// This scenario is NOT covered here. A SIGKILL precisely during a 40-record
		// backfill is non-deterministic (it completes in milliseconds). The backfill-
		// resume idempotency fix (#4) is covered by unit tests in
		// unitTests/resources/vectorIndex.test.js ('backfill resume idempotency').
	});
});
