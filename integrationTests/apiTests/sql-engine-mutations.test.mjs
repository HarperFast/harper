/**
 * Behavioral integration tests for the new SQL engine's mutation path (phase 4).
 *
 * Boots a real Harper instance with HARPER_SQL_ENGINE=new so every `sql`
 * operation is handled by the new Resource-API engine (not the legacy AlaSQL
 * path). Exercises INSERT / UPDATE / DELETE against real storage and verifies
 * both the persisted data (read back via NoSQL search_by_hash) and the legacy
 * response shapes (inserted_hashes / update_hashes / deleted_hashes + messages).
 *
 * This is the real-storage counterpart to the mocked unitTests/sqlEngine/
 * mutation.test.js — it confirms the transaction()/create/put/patch/delete
 * invocation actually commits atomically against LMDB/RocksDB.
 *
 * Self-contained: creates its own schema/table in before().
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';

suite('New SQL engine — mutations (phase 4)', (ctx) => {
	let client;

	const sql = (statement) => client.req().send({ operation: 'sql', sql: statement });
	const byHash = (table, ids) =>
		client.req().send({ operation: 'search_by_hash', schema: 'dev', table, hash_values: ids, get_attributes: ['*'] });

	before(async () => {
		// HARPER_SQL_ENGINE=new forces the new engine; a fallback to legacy would
		// surface as an error rather than a silent pass.
		await startHarper(ctx, { config: {}, env: { HARPER_SQL_ENGINE: 'new' } });
		client = createApiClient(ctx.harper);

		await client.req().send({ operation: 'create_schema', schema: 'dev' }).expect(200);
		await client
			.req()
			.send({ operation: 'create_table', schema: 'dev', table: 'widget', primary_key: 'id' })
			.expect(200);
		// Seed a few rows via NoSQL so the UPDATE/DELETE tests have targets.
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'widget',
				records: [
					{ id: 1, name: 'alpha', qty: 10 },
					{ id: 2, name: 'beta', qty: 20 },
					{ id: 3, name: 'gamma', qty: 30 },
				],
			})
			.expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('INSERT … VALUES persists rows and returns inserted_hashes', async () => {
		const res = await sql("INSERT INTO dev.widget (id, name, qty) VALUES (4, 'delta', 40), (5, 'eps', 50)").expect(200);
		assert.deepEqual(res.body.inserted_hashes?.sort(), [4, 5]);
		assert.deepEqual(res.body.skipped_hashes, []);
		assert.match(res.body.message, /inserted 2 of 2 records/);

		const read = await byHash('widget', [4, 5]).expect(200);
		const rows = read.body.sort((a, b) => a.id - b.id);
		assert.equal(rows.length, 2);
		assert.equal(rows[0].name, 'delta');
		assert.equal(rows[1].qty, 50);
	});

	test('INSERT skips an existing primary key (skipped_hashes)', async () => {
		const res = await sql("INSERT INTO dev.widget (id, name, qty) VALUES (2, 'dup', 999), (6, 'zeta', 60)").expect(200);
		assert.deepEqual(res.body.inserted_hashes, [6]);
		assert.deepEqual(res.body.skipped_hashes, [2]);

		// Existing row 2 must be untouched (skip, not overwrite).
		const read = await byHash('widget', [2]).expect(200);
		assert.equal(read.body[0].name, 'beta');
		assert.equal(read.body[0].qty, 20);
	});

	test('UPDATE … SET applies to matched rows and returns update_hashes', async () => {
		const res = await sql("UPDATE dev.widget SET name = 'renamed' WHERE id = 1").expect(200);
		assert.deepEqual(res.body.update_hashes, [1]);
		assert.match(res.body.message, /updated 1 of 1 records/);

		const read = await byHash('widget', [1]).expect(200);
		assert.equal(read.body[0].name, 'renamed');
		assert.equal(read.body[0].qty, 10); // untouched field preserved
	});

	test('UPDATE with a relative assignment reads the existing value', async () => {
		const res = await sql('UPDATE dev.widget SET qty = qty + 5 WHERE id = 3').expect(200);
		assert.deepEqual(res.body.update_hashes, [3]);
		const read = await byHash('widget', [3]).expect(200);
		assert.equal(read.body[0].qty, 35);
	});

	test('DELETE removes matched rows and returns deleted_hashes', async () => {
		const res = await sql('DELETE FROM dev.widget WHERE id = 5').expect(200);
		assert.deepEqual(res.body.deleted_hashes, [5]);
		assert.match(res.body.message, /1 of 1 records successfully deleted/);

		const read = await byHash('widget', [5]).expect(200);
		assert.equal(read.body.length, 0);
	});
});
