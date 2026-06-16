/**
 * Advanced blob integration tests — issue #1195
 *
 * Covers patterns observed in production that are NOT tested by blob.test.mjs:
 *
 *   1. Per-device-type database sharding — two tables in separate LMDB databases
 *      (cache_desktop / cache_mobile) hold records with the same primary key;
 *      neither table sees the other's data.
 *
 *   2. Multi-path blobPaths config active — Harper starts with two blobPaths
 *      configured; Bytes records are stored and retrieved byte-exact, confirming
 *      the multi-path config does not interfere with normal table I/O. (See the
 *      Bytes-vs-Blob note below: Bytes is inline storage and does not exercise
 *      blobPaths file striping.)
 *
 *   3. Large Bytes payload (200KB) — a 200KB payload round-trips with the
 *      multi-path config active, without truncation or corruption.
 *
 * The fixture pre-defines DesktopPage and MobilePage tables in separate databases.
 * blobPaths are supplied at start time via `storage.blobPaths` in the config option.
 *
 * Note on Bytes vs Blob and blobPaths: `storage.blobPaths` controls where file-backed
 * `Blob`-type columns are written. This suite uses `Bytes` (inline DB storage) so it
 * tests that the blobPaths configuration does not interfere with normal table I/O.
 * Full Blob-type striping coverage (verifying files land in both paths) requires a
 * custom component resource that calls `createBlob()`, which is left to a future test.
 *
 * Note on Bytes round-trip: the REST layer accepts a Bytes field as a JSON string
 * (stored as Buffer.from(value, 'utf8')) and returns it as
 * `{"type":"Buffer","data":[...utf8 byte values...]}` (Node.js Buffer.toJSON format).
 * Tests verify the decoded Buffer matches the original string bytes. Content uses
 * printable ASCII so the UTF-8 round-trip is lossless.
 *
 * Skipped on Windows: depends on `restart_service http_workers` (HarperFast/harper#549).
 * Skipped on Bun: component install is not reliable under Harper-on-Bun in CI.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, notStrictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { startHarper, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error utils/components.mjs has no type declarations; runtime resolves fine
import { installAppComponent } from '../apiTests/utils/components.mjs';

const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

const FIXTURE_PATH = join(import.meta.dirname, '../fixtures/blob-advanced');
const SCHEMA_GRAPHQL = readFileSync(join(FIXTURE_PATH, 'schema.graphql'), 'utf8');
const CONFIG_YAML = readFileSync(join(FIXTURE_PATH, 'config.yaml'), 'utf8');

/**
 * Decode a Harper Bytes field from a REST JSON response body back to a Buffer.
 *
 * Harper serializes Bytes via Node.js Buffer.toJSON(), which produces
 * `{"type":"Buffer","data":[...byte values...]}`. This helper reconstructs
 * the original Buffer so tests can do byte-exact comparisons.
 */
function decodeHarperBytes(value: unknown): Buffer {
	ok(value !== null && typeof value === 'object', `expected Buffer JSON object, got ${JSON.stringify(value)}`);
	const obj = value as { type?: string; data?: number[] };
	strictEqual(obj.type, 'Buffer', `expected type 'Buffer', got '${obj.type}'`);
	ok(Array.isArray(obj.data), `expected data array, got ${JSON.stringify(obj.data)}`);
	return Buffer.from(obj.data);
}

suite('blob-advanced', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;

	/** Two temporary directories used as blob storage paths. */
	let blobDir1: string;
	let blobDir2: string;

	before(async () => {
		// Created in before() (not at suite-body scope) so the dirs are not created
		// when the suite is skipped on Windows/Bun, where after() never runs.
		blobDir1 = mkdtempSync(join(tmpdir(), 'harper-blob-test-1-'));
		blobDir2 = mkdtempSync(join(tmpdir(), 'harper-blob-test-2-'));
		await startHarper(ctx, {
			config: {
				storage: {
					blobPaths: [blobDir1, blobDir2],
				},
			},
			env: {},
		});
		client = createApiClient(ctx.harper);

		await installAppComponent(client, {
			project: 'blob-advanced',
			files: {
				'schema.graphql': SCHEMA_GRAPHQL,
				'config.yaml': CONFIG_YAML,
			},
			probePath: '/DesktopPage/',
			restartTimeoutMs: 120_000,
		});
	});

	after(async () => {
		await teardownHarper(ctx);
		// Clean up temporary blob directories
		for (const dir of [blobDir1, blobDir2]) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort; test isolation is more important than strict cleanup
			}
		}
	});

	/**
	 * Test 1: Per-device-type database sharding — no cross-DB bleed
	 *
	 * DesktopPage and MobilePage live in separate LMDB databases (cache_desktop
	 * and cache_mobile). Writing the same primary key to each table must produce
	 * two isolated records: each table returns only its own content, and a key
	 * that exists only in MobilePage must 404 on DesktopPage.
	 *
	 * Harper's Bytes field accepts JSON strings and stores them as UTF-8 Buffers.
	 */
	test('per-device-type DB sharding: no cross-DB bleed', { timeout: 30_000 }, async () => {
		// Verify the tables are in the correct separate databases before writing any data
		const describeResp = await client.req().send({ operation: 'describe_all' }).expect(200);
		const schema = describeResp.body;
		ok(
			schema?.cache_desktop?.DesktopPage,
			`DesktopPage must be in cache_desktop schema; got: ${JSON.stringify(Object.keys(schema))}`
		);
		ok(
			schema?.cache_mobile?.MobilePage,
			`MobilePage must be in cache_mobile schema; got: ${JSON.stringify(Object.keys(schema))}`
		);
		ok(!schema?.cache_desktop?.MobilePage, 'MobilePage must NOT appear in cache_desktop (schema isolation check)');
		ok(!schema?.cache_mobile?.DesktopPage, 'DesktopPage must NOT appear in cache_mobile (schema isolation check)');

		const desktopStr = '<html>desktop</html>';
		const mobileStr = '<html>mobile</html>';
		const desktopExpected = Buffer.from(desktopStr);
		const mobileExpected = Buffer.from(mobileStr);

		// Write page1 to DesktopPage
		await request(client.restURL)
			.put('/DesktopPage/page1')
			.set(client.headers)
			.send({ id: 'page1', content: desktopStr, contentType: 'text/html' })
			.expect(204);

		// Write page1 to MobilePage — same primary key, different database
		await request(client.restURL)
			.put('/MobilePage/page1')
			.set(client.headers)
			.send({ id: 'page1', content: mobileStr, contentType: 'text/html' })
			.expect(204);

		// Read back DesktopPage/page1 — must return desktop content
		const desktopResp = await request(client.restURL).get('/DesktopPage/page1').set(client.headers).expect(200);

		ok(desktopResp.body, 'DesktopPage/page1 should return a body');
		strictEqual(desktopResp.body.contentType, 'text/html', 'DesktopPage record should have contentType text/html');
		const desktopBytes = decodeHarperBytes(desktopResp.body.content);
		strictEqual(desktopBytes.compare(desktopExpected), 0, 'DesktopPage content must match what was stored');

		// Read back MobilePage/page1 — must return mobile content
		const mobileResp = await request(client.restURL).get('/MobilePage/page1').set(client.headers).expect(200);

		ok(mobileResp.body, 'MobilePage/page1 should return a body');
		strictEqual(mobileResp.body.contentType, 'text/html', 'MobilePage record should have contentType text/html');
		const mobileBytes = decodeHarperBytes(mobileResp.body.content);
		strictEqual(mobileBytes.compare(mobileExpected), 0, 'MobilePage content must match what was stored');

		// The two records must not be identical (cross-DB bleed would make them equal)
		notStrictEqual(
			desktopBytes.compare(mobileBytes),
			0,
			'DesktopPage and MobilePage records for the same key must hold different content (no cross-DB bleed)'
		);

		// Write page2 only to MobilePage — DesktopPage must return 404
		await request(client.restURL)
			.put('/MobilePage/page2')
			.set(client.headers)
			.send({ id: 'page2', content: mobileStr, contentType: 'text/html' })
			.expect(204);

		await request(client.restURL).get('/DesktopPage/page2').set(client.headers).expect(404);
	});

	/**
	 * Test 2: Multi-path blobPaths config active — Bytes data stored and retrievable
	 *
	 * Store 4 records with ~10KB Bytes payloads while two blobPaths are configured,
	 * and verify all 4 are retrievable byte-exact. Bytes is inline DB storage, so
	 * this confirms the multi-path config does not interfere with normal table I/O;
	 * it does not exercise blobPaths file striping (that requires Blob columns).
	 *
	 * Content strings are built from repeating ASCII patterns so the UTF-8
	 * Buffer.from() encoding is lossless and the byte-exact comparison is valid.
	 */
	test(
		'multi-path blobPaths config: Bytes records stored and retrievable byte-exact',
		{ timeout: 30_000 },
		async () => {
			const BLOB_SIZE = 10 * 1024; // 10KB

			// Build 4 distinct payloads using ASCII characters (safe for UTF-8 round-trip)
			const payloads: Buffer[] = Array.from(
				{ length: 4 },
				(_, i) => Buffer.from(String.fromCharCode(65 + i).repeat(BLOB_SIZE)) // 'A', 'B', 'C', 'D' repeated
			);

			// Store all 4 records
			for (let i = 0; i < payloads.length; i++) {
				await request(client.restURL)
					.put(`/DesktopPage/multi-${i}`)
					.set(client.headers)
					.send({
						id: `multi-${i}`,
						content: payloads[i].toString(), // ASCII string → stored as UTF-8 Buffer
						contentType: 'application/octet-stream',
					})
					.expect(204);
			}

			// Retrieve each record via REST and verify byte-exact content
			for (let i = 0; i < payloads.length; i++) {
				const resp = await request(client.restURL).get(`/DesktopPage/multi-${i}`).set(client.headers).expect(200);

				ok(resp.body.content, `record multi-${i} should have content`);
				const returned = decodeHarperBytes(resp.body.content);

				strictEqual(
					returned.length,
					payloads[i].length,
					`record multi-${i}: returned length ${returned.length} !== expected ${payloads[i].length}`
				);
				strictEqual(
					returned.compare(payloads[i]),
					0,
					`record multi-${i}: content mismatch (byte-exact comparison failed)`
				);
			}
		}
	);

	/**
	 * Test 3: Large blob (200KB) through multi-path setup
	 *
	 * A 200KB ASCII payload must survive the round-trip without truncation or
	 * corruption. Content uses only printable ASCII so the UTF-8 Buffer round-trip
	 * is lossless.
	 */
	test(
		'large Bytes payload (200KB) round-trip with multi-path blobPaths config active',
		{ timeout: 30_000 },
		async () => {
			const LARGE_SIZE = 200 * 1024; // 200KB

			// Repeating printable ASCII pattern (32–126) — safe for UTF-8 Buffer.from()
			const chars = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
			let str = '';
			while (str.length < LARGE_SIZE) str += chars;
			const content = str.slice(0, LARGE_SIZE);
			const expected = Buffer.from(content);

			await request(client.restURL)
				.put('/DesktopPage/large-blob')
				.set(client.headers)
				.send({
					id: 'large-blob',
					content,
					contentType: 'application/octet-stream',
				})
				.expect(204);

			const resp = await request(client.restURL).get('/DesktopPage/large-blob').set(client.headers).expect(200);

			ok(resp.body.content, 'large-blob record should have content');
			const returned = decodeHarperBytes(resp.body.content);

			strictEqual(returned.length, LARGE_SIZE, `large-blob: returned length ${returned.length} !== ${LARGE_SIZE}`);
			strictEqual(returned.compare(expected), 0, 'large-blob: content mismatch (byte-exact comparison failed)');
		}
	);
});
