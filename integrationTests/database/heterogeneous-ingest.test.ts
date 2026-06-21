/**
 * Regression guard for HarperFast/harper#1282 — schema-less heterogeneous ingest must not lose records.
 *
 * Ingesting many records of highly varied shapes into an OPEN table (primary key only, not @sealed)
 * exercises the high-shape-cardinality path of the record encoder. RecordEncoder sets msgpackr's
 * `maxOwnStructures` to 256, which puts msgpackr in two-byte-record mode; correctly round-tripping
 * those records on read depends on structon's structure-persistence hooks preserving the shared/own
 * bookkeeping. #1282 reported the vast majority of such records decoding as `null` (#1163 "shared
 * structure missing") on a single node — that was traced to a stale `structon` (< 1.0.7) in
 * node_modules; structon >= 1.0.7 (which harper pins) handles it correctly. This test pins the
 * invariant so a structon regression or an accidental downgrade can't silently reintroduce the loss.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'heterogeneous-ingest');

// 2_000 distinct shapes is far above msgpackr's ~32-structure one-byte-record boundary, so it exercises
// the two-byte-record + structure-recycling path where #1282's loss occurred — but stays fast in CI.
const RECORD_COUNT = 2_000;
const BATCH_SIZE = 500;

/** Small, deterministic PRNG (mulberry32) so shape generation is reproducible. */
function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const KEY_POOL = Array.from({ length: 200 }, (_, i) => `k${i}`);

/** Random scalar/array/object value with random type — drives type churn per key. */
function randValue(rng: () => number, depth: number): unknown {
	const r = rng();
	if (depth <= 0 || r < 0.45) {
		const t = rng();
		if (t < 0.3) return Math.floor(rng() * 1e9);
		if (t < 0.55) return rng() * 1000;
		if (t < 0.8) return `s${Math.floor(rng() * 1e6).toString(36)}`;
		if (t < 0.92) return rng() < 0.5;
		return null;
	}
	if (r < 0.7) {
		const n = 1 + Math.floor(rng() * 5);
		return Array.from({ length: n }, () => randValue(rng, 0));
	}
	const n = 1 + Math.floor(rng() * 4);
	const o: Record<string, unknown> = {};
	for (let i = 0; i < n; i++) o[KEY_POOL[Math.floor(rng() * KEY_POOL.length)]] = randValue(rng, depth - 1);
	return o;
}

/** A record with a (probabilistically) distinct shape: random key subset, nesting, and value types. */
function heterogeneousRecord(rng: () => number, id: number): Record<string, unknown> {
	const rec: Record<string, unknown> = { id: String(id) };
	const keyCount = 3 + Math.floor(rng() * 18); // 3..20 keys
	for (let i = 0; i < keyCount; i++) rec[KEY_POOL[Math.floor(rng() * KEY_POOL.length)]] = randValue(rng, 3);
	return rec;
}

suite('heterogeneous schema-less ingest (#1282)', (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		// Poll until the open table route/table is ready.
		const deadline = Date.now() + 30_000;
		let tableReady = false;
		while (Date.now() < deadline) {
			const r = await client
				.reqRest('/Het/')
				.timeout(5_000)
				.catch(() => ({ status: 0 }));
			if ((r as any).status !== 404 && (r as any).status !== 0) {
				tableReady = true;
				break;
			}
			await sleep(250);
		}
		ok(tableReady, 'Het table did not become ready within 30 s — cannot run ingest test');
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('every heterogeneous record reads back intact (no null/dropped records)', async () => {
		const rng = makeRng(0xc0ffee);
		for (let start = 0; start < RECORD_COUNT; start += BATCH_SIZE) {
			const records: Record<string, unknown>[] = [];
			for (let i = start; i < start + BATCH_SIZE && i < RECORD_COUNT; i++) records.push(heterogeneousRecord(rng, i));
			await client.req().send({ operation: 'insert', schema: 'data', table: 'Het', records }).expect(200);
		}

		// Read every record back by id in one request. A record that fails to decode (the #1282 path)
		// comes back null/missing rather than as its object, so a full, intact result set is the guard.
		const ids = Array.from({ length: RECORD_COUNT }, (_, i) => String(i));
		const res = await client
			.req()
			.send({ operation: 'search_by_id', schema: 'data', table: 'Het', ids, get_attributes: ['*'] })
			.expect(200);

		const rows: any[] = Array.isArray(res.body) ? res.body : [];
		const intact = rows.filter(
			(row) => row && typeof row === 'object' && row.id != null && Object.keys(row).length > 1
		);
		strictEqual(
			intact.length,
			RECORD_COUNT,
			`expected all ${RECORD_COUNT} heterogeneous records to read back intact, got ${intact.length} ` +
				`(rows returned=${rows.length}); shortfall indicates #1282 shared-structure data loss`
		);

		// Spot-check that a deep record round-tripped its exact value, not just a non-empty shell.
		const probeRng = makeRng(0xc0ffee);
		let expected: Record<string, unknown> | undefined;
		for (let i = 0; i <= 1234; i++) {
			const r = heterogeneousRecord(probeRng, i);
			if (i === 1234) expected = r;
		}
		const byId = new Map(intact.map((row) => [row.id, row]));
		const got = byId.get('1234');
		ok(got, 'record 1234 should be present');
		deepStrictEqual(got, expected, 'record 1234 should round-trip exactly (values, not just shape)');
	});
});
