/**
 * Regression: non-object record roots are rejected on write, so they can never wedge
 * a table's scans (#1298).
 *
 * Background: `application/octet-stream` deserializes to the raw Buffer, and a path like
 * `/Item/<id>/bytes` is just a record whose primary key is the compound string "<id>/bytes"
 * (slashes are not attribute paths — only `id.attr` dot syntax is). So an octet-stream PUT
 * stored a record whose entire value was a bare TypedArray. V8 refuses to Object.freeze a
 * non-empty TypedArray, so every unfiltered scan over the table then 500'd — and because the
 * key was the compound string, a point GET/DELETE by the plain id never matched it, leaving the
 * table permanently wedged.
 *
 * Fix: the record-write path (Table._writeUpdate) rejects any non-object record root (primitive,
 * string/number, or bare binary) with a 400 — binary belongs in a Bytes/Blob attribute, not as
 * the whole record. Messages (MQTT/topic publish, via _writePublish) are a separate path and may
 * still carry raw payloads. This
 * test asserts the bad writes are blocked, a legitimate binary-in-attribute record round-trips
 * and scans cleanly, and no poison can be created. (The read-side freeze guard that lets an
 * already-poisoned table recover after upgrade is covered by unitTests/resources/freeze-record.test.js.)
 *
 * Skipped on Windows (restart_service http_workers crashes the instance — harper#549).
 *
 * Implements HarperFast/harper#1298.
 */
import { suite, test, before, after } from 'node:test';
import { ok } from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { encode as cborEncode } from 'cbor-x';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/bytes-scan-crash');
const skipSuite = process.platform === 'win32';
const SCHEMA = 'data';
const TABLE = 'Item';
const BLOB_BYTES = Buffer.from([0, 1, 2, 253, 254, 255, 0x89, 0x50, 0x4e, 0x47]);

suite('non-object record roots rejected on write (#1298)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let restURL: string;
	let authHeaders: Record<string, string>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		restURL = client.restURL;
		authHeaders = { Authorization: client.headers.Authorization, Connection: 'close' };

		// Wait for the REST route to come up.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest(`/${TABLE}/`).timeout(3_000);
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

	// The original repro: octet-stream PUT whose body becomes a bare-TypedArray record root.
	// Must be rejected with a 400, not stored (and never a 500).
	test('octet-stream bare-buffer PUT is rejected with 400', async () => {
		const r = await request(restURL)
			.put(`/${TABLE}/poison/bytes`)
			.set(authHeaders)
			.set('Content-Type', 'application/octet-stream')
			.send(BLOB_BYTES)
			.timeout(10_000);
		ok(r.status === 400, `expected 400, got ${r.status}: ${r.text}`);
	});

	// A plain octet-stream PUT to a record id (no slash) is the same bare-root shape.
	test('octet-stream bare-buffer PUT to a plain id is rejected with 400', async () => {
		const r = await request(restURL)
			.put(`/${TABLE}/blobby`)
			.set(authHeaders)
			.set('Content-Type', 'application/octet-stream')
			.send(BLOB_BYTES)
			.timeout(10_000);
		ok(r.status === 400, `expected 400, got ${r.status}: ${r.text}`);
	});

	// A bare JSON array is also a non-object root (typeof === 'object' but Array.isArray === true).
	test('bare JSON array record root is rejected with 400', async () => {
		const r = await request(restURL)
			.put(`/${TABLE}/arr`)
			.set(authHeaders)
			.set('Content-Type', 'application/json')
			.send('[1,2,3]')
			.timeout(10_000);
		ok(r.status === 400, `array root: expected 400, got ${r.status}: ${r.text}`);
	});

	// String / number JSON bodies are non-object roots too.
	test('primitive (string/number) record roots are rejected with 400', async () => {
		const asString = await request(restURL)
			.put(`/${TABLE}/str`)
			.set(authHeaders)
			.set('Content-Type', 'application/json')
			.send('"just a string"')
			.timeout(10_000);
		ok(asString.status === 400, `string root: expected 400, got ${asString.status}: ${asString.text}`);

		const asNumber = await request(restURL)
			.put(`/${TABLE}/num`)
			.set(authHeaders)
			.set('Content-Type', 'application/json')
			.send('42')
			.timeout(10_000);
		ok(asNumber.status === 400, `number root: expected 400, got ${asNumber.status}: ${asNumber.text}`);
	});

	// The supported way to store binary: a Bytes attribute inside an object record. Round-trips
	// and scans cleanly.
	test('binary inside a Bytes attribute writes and scans cleanly', async () => {
		const put = await request(restURL)
			.put(`/${TABLE}/good`)
			.set(authHeaders)
			.set('Content-Type', 'application/cbor')
			.send(cborEncode({ id: 'good', bytes: BLOB_BYTES, note: 'object-root' }))
			.timeout(10_000);
		ok(put.status >= 200 && put.status < 300, `Bytes-attribute PUT should succeed, got ${put.status}: ${put.text}`);

		const sql = await client
			.req()
			.send({ operation: 'sql', sql: `SELECT * FROM ${SCHEMA}.${TABLE}` })
			.timeout(10_000);
		ok(sql.status === 200, `SELECT * expected 200, got ${sql.status}: ${JSON.stringify(sql.body)}`);
		ok(
			Array.isArray(sql.body) && sql.body.some((r: any) => r.id === 'good'),
			`expected the 'good' row, got ${JSON.stringify(sql.body)}`
		);

		const scan = await request(restURL)
			.get(`/${TABLE}/`)
			.set(authHeaders)
			.set('Accept', 'application/json')
			.timeout(10_000);
		ok(scan.status === 200, `REST scan expected 200, got ${scan.status}: ${scan.text}`);
	});

	// Belt-and-suspenders: after all the rejected writes, the table is still fully scannable —
	// no poison record slipped through.
	test('no poison was created — table remains scannable', async () => {
		const sql = await client
			.req()
			.send({ operation: 'sql', sql: `SELECT * FROM ${SCHEMA}.${TABLE}` })
			.timeout(10_000);
		ok(sql.status === 200, `expected 200, got ${sql.status}: ${JSON.stringify(sql.body)}`);
	});
});
