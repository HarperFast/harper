/**
 * Schema-type contract integration tests — Category 1 / §5.1 of the Harper v5
 * Integration Test Plan.
 *
 * Covers five schema-type behaviors not formally tested by existing suites:
 *
 *   1. @sealed table — writes with undeclared fields are rejected; declared fields accepted.
 *      (Informed by qa-scratch/sealed-audit.test.ts, which characterised the real @sealed
 *      contract: schema-strict, not immutable.)
 *
 *   2. Brotli-compressed Blob — raw brotli bytes stored and retrieved byte-exact via the
 *      BrotliStore custom resource (fixtures/schema-types/resources.js); Content-Encoding: br
 *      header passed through from stored metadata without server-side decompression.
 *
 *   3. [String] array field with @indexed — CRUD round-trip; search_by_value against an
 *      individual element returns the record(s) that contain it.
 *
 *   4. Schema-less (open) table — only a primary key declared, no @sealed; arbitrary
 *      record shapes are stored and retrieved by PK without coercion (MQTT
 *      retained-message pattern).
 *
 *   5. Null / empty optional fields — declared optional fields left null/undefined are
 *      not coerced to empty-string or 0 on round-trip.
 *
 * Self-contained: all tables and resources live in a single fixture component
 * (fixtures/schema-types/). BrotliStore is defined in fixtures/schema-types/resources.js.
 *
 * Skipped on Windows: restart_service http_workers crashes Harper on Windows
 * (HarperFast/harper#549). Skipped on Bun: component install timing is not
 * reliable under Harper-on-Bun in CI.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert/strict';
import { brotliCompressSync } from 'node:zlib';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as http from 'node:http';
import request from 'supertest';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

/**
 * Perform a raw HTTP GET that bypasses Node's built-in and supertest/superagent
 * Content-Encoding decompression.  Returns the raw response buffer and headers.
 */
function rawHttpGet(
	url: string,
	headers: Record<string, string>
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const opts: http.RequestOptions = {
			hostname: parsed.hostname,
			port: parsed.port ? Number(parsed.port) : 80,
			path: parsed.pathname + parsed.search,
			method: 'GET',
			headers,
		};
		const req = http.request(opts, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () =>
				resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
			);
		});
		req.on('error', reject);
		req.end();
	});
}

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/schema-types');
const skipSuite = process.platform === 'win32' || process.env.HARPER_RUNTIME === 'bun';

suite('Schema-type contracts', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	type Client = ReturnType<typeof createApiClient>;
	let client: Client;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		// Poll until SealedItem route is registered — confirms the fixture is fully loaded.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/SealedItem/').timeout(3_000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(250);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ─── Case 1: @sealed ─────────────────────────────────────────────────────

	suite('@sealed table', () => {
		test('declared fields are accepted', async () => {
			const r = await client.req().send({
				operation: 'insert',
				schema: 'data',
				table: 'SealedItem',
				records: [{ id: 'sealed-ok', name: 'allowed', value: 42 }],
			});
			strictEqual(r.status, 200, `insert of declared fields should succeed; got ${r.status}: ${r.text}`);

			// Verify the record is readable.
			const read = await client.reqRest('/SealedItem/sealed-ok').timeout(10_000).expect(200);
			strictEqual(read.body.name, 'allowed');
			strictEqual(read.body.value, 42);
		});

		test('insert with an undeclared field is rejected', async () => {
			const write = await client.req().send({
				operation: 'insert',
				schema: 'data',
				table: 'SealedItem',
				records: [{ id: 'sealed-bad', name: 'allowed', UNDECLARED: 'must-be-rejected' }],
			});

			// @sealed throws a ClientError (HTTP 400) for undeclared fields — the write must
			// be rejected with an error status, not silently succeed.
			ok(
				write.status >= 400,
				`@sealed must reject the insert with an error status; got ${write.status}: ${write.text}`
			);

			// Belt-and-suspenders: the record must also not be stored.
			const read = await client.reqRest('/SealedItem/sealed-bad').timeout(10_000);
			ok(
				read.status === 404 || read.body?.UNDECLARED == null,
				`@sealed must prevent the undeclared-field record from being stored; found: ${JSON.stringify(read.body)}`
			);
		});

		test('REST PUT with undeclared field is rejected', async () => {
			const write = await request(client.restURL)
				.put('/SealedItem/sealed-rest-bad')
				.set(client.headers)
				.send({ id: 'sealed-rest-bad', name: 'ok', UNDECLARED: 'forbidden' });

			// @sealed must reject the PUT with an error status, not strip the field silently.
			ok(write.status >= 400, `@sealed must reject REST PUT with an error status; got ${write.status}: ${write.text}`);

			// Belt-and-suspenders: the record must also not be stored.
			const read = await client.reqRest('/SealedItem/sealed-rest-bad').timeout(10_000);
			ok(
				read.status === 404 || read.body?.UNDECLARED == null,
				`@sealed must prevent the undeclared-field record from being stored; found: ${JSON.stringify(read.body)}`
			);
		});
	});

	// ─── Case 2: Brotli-compressed Blob ──────────────────────────────────────
	//
	// BrotliStore resource (fixtures/schema-types/resources.js) accepts raw bytes
	// via POST with an X-Harper-Encoding header (NOT Content-Encoding, which would
	// trigger HTTP-level decompression). Stores them byte-exact as a Blob in the
	// BrotliBlob table. GET returns the raw bytes with Content-Encoding: br.

	suite('Brotli-compressed Blob', () => {
		const brotliId = 'brotli-1';
		let compressed: Buffer;

		before(async () => {
			const original = Buffer.from('Hello Harper — brotli round-trip test payload!');
			compressed = brotliCompressSync(original);

			// Poll until BrotliStore route is ready (loaded alongside the fixture tables).
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/BrotliStore/probe').timeout(3_000);
					// 404 means "not registered"; any other status (200, 405...) = route exists.
					if (probe.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(250);
			}
		});

		test('brotli-compressed bytes stored and retrieved byte-exact', async () => {
			// Store via POST — send the raw brotli bytes as application/octet-stream.
			// We use X-Harper-Encoding (not Content-Encoding) because HTTP-level
			// Content-Encoding: br would cause the server to decompress the body before
			// the resource handler sees it, defeating the byte-exact round-trip test.
			const postResp = await request(client.restURL)
				.post(`/BrotliStore/${brotliId}`)
				.set(client.headers)
				.set('Content-Type', 'application/octet-stream')
				.set('X-Harper-Encoding', 'br')
				.send(compressed);

			ok(postResp.status < 300, `POST should succeed; got ${postResp.status}: ${postResp.text}`);

			// Retrieve using a raw http.request to bypass superagent/supertest's automatic
			// Content-Encoding decompression (which would silently decompress the brotli
			// payload and hand us the uncompressed bytes instead of the stored raw bytes).
			const getResp = await rawHttpGet(`${client.restURL}/BrotliStore/${brotliId}`, {
				...client.headers,
				Accept: 'application/octet-stream',
			});

			strictEqual(getResp.statusCode, 200, `GET should return 200; got ${getResp.statusCode}`);

			// Bytes must be stored and returned verbatim (Harper must NOT decompress brotli).
			deepStrictEqual(getResp.body, compressed, 'retrieved bytes must match the stored brotli payload byte-for-byte');
		});

		test('Content-Encoding: br header passes through unchanged', async () => {
			const getResp = await request(client.restURL)
				.get(`/BrotliStore/${brotliId}`)
				.set(client.headers)
				.set('Accept', 'application/octet-stream')
				.expect(200);

			// The custom resource surfaces the stored encoding value — Harper must
			// not strip or overwrite it with server-side compression metadata.
			strictEqual(
				getResp.headers['content-encoding'],
				'br',
				`Content-Encoding must be 'br'; got '${getResp.headers['content-encoding']}'`
			);
		});
	});

	// ─── Case 3: [String] array field with @indexed ──────────────────────────

	suite('[String] array field — CRUD and indexed search', () => {
		test('array field round-trips via ops insert + REST GET', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'data',
					table: 'TaggedItem',
					records: [{ id: 'tagged-1', tags: ['alpha', 'beta', 'gamma'], label: 'first' }],
				})
				.expect(200);

			const read = await client.reqRest('/TaggedItem/tagged-1').timeout(10_000).expect(200);
			deepStrictEqual(read.body.tags, ['alpha', 'beta', 'gamma'], 'array field must round-trip faithfully');
		});

		test('ops search_by_value on array element returns the containing record', async () => {
			// Insert a second record to ensure we are selecting, not just listing.
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'data',
					table: 'TaggedItem',
					records: [{ id: 'tagged-2', tags: ['delta', 'epsilon'], label: 'second' }],
				})
				.expect(200);

			const r = await client
				.req()
				.send({
					operation: 'search_by_value',
					schema: 'data',
					table: 'TaggedItem',
					search_attribute: 'tags',
					search_value: 'beta',
					get_attributes: ['id', 'tags'],
				})
				.timeout(20_000)
				.expect(200);

			ok(Array.isArray(r.body), `expected array response; got: ${JSON.stringify(r.body)}`);
			const ids = r.body.map((rec: { id: string }) => rec.id);
			ok(ids.includes('tagged-1'), `search for element 'beta' must return tagged-1; got: ${JSON.stringify(ids)}`);
			ok(!ids.includes('tagged-2'), `search for 'beta' must NOT return tagged-2; got: ${JSON.stringify(ids)}`);
		});

		test('REST PUT update preserves array field', async () => {
			await request(client.restURL)
				.put('/TaggedItem/tagged-1')
				.set(client.headers)
				.send({ id: 'tagged-1', tags: ['alpha', 'beta', 'gamma', 'delta'], label: 'updated' })
				.expect(204);

			const read = await client.reqRest('/TaggedItem/tagged-1').timeout(10_000).expect(200);
			deepStrictEqual(
				read.body.tags,
				['alpha', 'beta', 'gamma', 'delta'],
				'updated array field must round-trip faithfully'
			);
		});

		test('REST DELETE removes tagged record', async () => {
			const del = await request(client.restURL).delete('/TaggedItem/tagged-1').set(client.headers);
			// Harper returns 200 or 204 for successful DELETE.
			ok(del.status === 200 || del.status === 204, `DELETE should succeed; got ${del.status}`);
			const read = await client.reqRest('/TaggedItem/tagged-1').timeout(10_000);
			strictEqual(read.status, 404, 'deleted record must return 404');
		});
	});

	// ─── Case 4: Schema-less (open) table ────────────────────────────────────

	suite('Schema-less (open) table — MQTT retained-message pattern', () => {
		test('heterogeneous record stored and retrieved by primary key', async () => {
			const payload = {
				id: 'raw-1',
				topic: 'sensors/temperature',
				value: 23.5,
				unit: 'C',
				ts: 1700000000000,
				meta: { sensor: 'dht22', floor: 3 },
			};

			await client
				.req()
				.send({ operation: 'insert', schema: 'data', table: 'RawMessage', records: [payload] })
				.expect(200);

			const read = await client.reqRest('/RawMessage/raw-1').timeout(10_000).expect(200);
			strictEqual(read.body.id, 'raw-1');
			strictEqual(read.body.topic, 'sensors/temperature');
			strictEqual(read.body.value, 23.5);
			strictEqual(read.body.unit, 'C');
			deepStrictEqual(read.body.meta, { sensor: 'dht22', floor: 3 });
		});

		test('second record with a different shape coexists without interference', async () => {
			// Different field set — confirms no typed-structure coercion across records.
			const payload2 = {
				id: 'raw-2',
				device: 'lock-42',
				state: 'locked',
				batteryPct: 87,
			};

			await client
				.req()
				.send({ operation: 'insert', schema: 'data', table: 'RawMessage', records: [payload2] })
				.expect(200);

			const read1 = await client.reqRest('/RawMessage/raw-1').timeout(10_000).expect(200);
			const read2 = await client.reqRest('/RawMessage/raw-2').timeout(10_000).expect(200);

			strictEqual(read1.body.topic, 'sensors/temperature', 'raw-1 unchanged after raw-2 insert');
			strictEqual(read2.body.device, 'lock-42');
			strictEqual(read2.body.state, 'locked');
		});

		test('upsert (REST PUT) overwrites record at same PK', async () => {
			const updated = { id: 'raw-2', device: 'lock-42', state: 'unlocked', batteryPct: 86 };

			await request(client.restURL).put('/RawMessage/raw-2').set(client.headers).send(updated).expect(204);

			const read = await client.reqRest('/RawMessage/raw-2').timeout(10_000).expect(200);
			strictEqual(read.body.state, 'unlocked', 'REST PUT must overwrite the retained message');
		});
	});

	// ─── Case 5: Null / empty optional fields ────────────────────────────────

	suite('Null / empty optional fields — no coercion on round-trip', () => {
		test('null optional fields are not coerced to empty-string or 0', async () => {
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'data',
					table: 'NullableItem',
					records: [{ id: 'null-1', optStr: null, optNum: null, optBool: null }],
				})
				.expect(200);

			const read = await client.reqRest('/NullableItem/null-1').timeout(10_000).expect(200);

			// Each field was explicitly set to null; it must NOT come back as '' or 0.
			ok(read.body.optStr == null, `optStr:null must not be coerced; got '${JSON.stringify(read.body.optStr)}'`);
			ok(read.body.optNum == null, `optNum:null must not be coerced to 0; got '${JSON.stringify(read.body.optNum)}'`);
			ok(read.body.optBool == null, `optBool:null must not be coerced; got '${JSON.stringify(read.body.optBool)}'`);
		});

		test('absent optional fields are not injected as null or zero on read-back', async () => {
			// Insert without optional fields at all.
			await client
				.req()
				.send({
					operation: 'insert',
					schema: 'data',
					table: 'NullableItem',
					records: [{ id: 'null-2' }],
				})
				.expect(200);

			const read = await client.reqRest('/NullableItem/null-2').timeout(10_000).expect(200);

			// Absent fields must remain absent (or null) — not injected as '' or 0.
			ok(
				read.body.optStr !== '',
				`absent optStr must not appear as empty-string; got '${JSON.stringify(read.body.optStr)}'`
			);
			ok(read.body.optNum !== 0, `absent optNum must not appear as 0; got '${JSON.stringify(read.body.optNum)}'`);
			ok(
				read.body.optBool !== false,
				`absent optBool must not appear as false; got '${JSON.stringify(read.body.optBool)}'`
			);
		});

		test('ops search_by_id returns record with null fields intact', async () => {
			const r = await client
				.req()
				.send({
					operation: 'search_by_id',
					schema: 'data',
					table: 'NullableItem',
					ids: ['null-1'],
					get_attributes: ['*'],
				})
				.timeout(20_000)
				.expect(200);

			ok(
				Array.isArray(r.body) && r.body.length > 0,
				`search_by_id must return the record; got: ${JSON.stringify(r.body)}`
			);
			const rec = r.body[0];
			ok(rec.optStr == null, `ops: optStr:null must not be coerced; got '${JSON.stringify(rec.optStr)}'`);
			ok(rec.optNum == null, `ops: optNum:null must not be coerced to 0; got '${JSON.stringify(rec.optNum)}'`);
		});
	});
});
