/**
 * Record-structure dictionary saturation, end to end (HarperFast/harper#2220).
 *
 * Runs with `storage.randomAccessFields: true` -- the only configuration under which a table mints
 * typed structures at all -- and drives more distinct record shapes than the typed bound allows, to
 * prove describe_table's counts track the real dictionary, stop at the limit, and that records
 * written past the bound still read back correctly.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';

const SCHEMA = 'structdev';
const TABLE = 'ShapeDrift';
const SHAPES = 400; // > the 256 typed-structure bound

suite('Record-structure dictionary', (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: { storage: { randomAccessFields: true } }, env: {} });
		client = createApiClient(ctx.harper);
		await client.req().send({ operation: 'create_schema', schema: SCHEMA }).expect(200);
		await client
			.req()
			.send({ operation: 'create_table', schema: SCHEMA, table: TABLE, hash_attribute: 'id' })
			.expect(200);
	});

	after(async () => teardownHarper(ctx));

	const describe = async () =>
		(await client.req().send({ operation: 'describe_table', schema: SCHEMA, table: TABLE })).body;

	test('an untouched table reports an empty dictionary with typed encoding enabled', async () => {
		const body = await describe();
		assert.strictEqual(body.typed_structures_enabled, true, JSON.stringify(body));
		assert.strictEqual(body.typed_structure_count, 0, JSON.stringify(body));
		assert.ok(body.typed_structure_limit > 0, JSON.stringify(body));
	});

	test('more distinct shapes than the bound allows saturates it exactly', async () => {
		// Each record carries a uniquely-named field, so every write is a novel shape.
		const records = [];
		for (let i = 0; i < SHAPES; i++) records.push({ id: i, ['f' + i]: i });
		await client.req().send({ operation: 'insert', schema: SCHEMA, table: TABLE, records }).expect(200);
		await client
			.req()
			.send({ operation: 'sql', sql: `select * from ${SCHEMA}.${TABLE}` })
			.expect(200);

		const body = await describe();
		assert.ok(body.typed_structure_count > 0, `dictionary never grew: ${JSON.stringify(body)}`);
		assert.strictEqual(
			body.typed_structure_count,
			body.typed_structure_limit,
			`more shapes than the bound allows should saturate it exactly: ${JSON.stringify(body)}`
		);
		// msgpackr's shared named-record dictionary has its own, much smaller bound
		assert.ok(body.classic_structure_count > 0, JSON.stringify(body));
	});

	test('saturation is reported to the operator log', async () => {
		// The unit tests stub harperLogger, so this is the only check that the warning survives a real
		// logger binding -- the whole point of the signal is that an operator sees it.
		const r = await client.req().send({ operation: 'read_log', limit: 10000, level: 'warn' }).expect(200);
		const entries = Array.isArray(r.body) ? r.body : (r.body?.entries ?? []);
		const hit = entries.some((e) => typeof e.message === 'string' && e.message.includes('Typed-structure dictionary'));
		assert.ok(hit, `no saturation warning among ${entries.length} log entries`);
	});

	test('records written past the bound still read back correctly', async () => {
		const r = await client
			.req()
			.send({ operation: 'sql', sql: `select * from ${SCHEMA}.${TABLE} where id = ${SHAPES - 1}` })
			.expect(200);
		assert.strictEqual(r.body.length, 1, JSON.stringify(r.body));
		assert.strictEqual(r.body[0]['f' + (SHAPES - 1)], SHAPES - 1, JSON.stringify(r.body));
	});
});
