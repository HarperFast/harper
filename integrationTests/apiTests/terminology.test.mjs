/**
 * Terminology / alias integration tests.
 *
 * Ported from legacy `apiTests/tests/16_terminologyUpdates.mjs`. Validates
 * that the `database` parameter is accepted as an alias for `schema` across
 * all CRUD and metadata operations, and that `primary_key` is accepted as an
 * alias for `hash_attribute` in `create_table`.
 *
 * Self-contained: all schemas / tables created and torn down within the suite.
 * S3 and csv_url_load tests are skipped (require external infrastructure).
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { awaitJobCompleted } from './utils/operations.mjs';

// Resolve the CSV fixture path relative to this file so Harper can read it.
const SUPPLIERS_CSV = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/Suppliers.csv');

// On Bun shard 2, embed-directive tear-down (HNSW flush) starves the job processor,
// so csv_data_load can sit IN_PROGRESS past the default 30s. Same pattern as northwind.
const isBunRuntime = process.env.HARPER_RUNTIME === 'bun';
const JOB_TIMEOUT_SECONDS = isBunRuntime ? 120 : 30;

suite('Terminology aliases (database / primary_key)', (ctx) => {
	let client;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	// ── create_database / create_table / create_attribute ──────────────────

	test('create_database with database param', async () => {
		await client
			.req()
			.send({ operation: 'create_database', schema: 'tuckerdoodle' })
			.expect((r) => assert.equal(r.body.message, "database 'tuckerdoodle' successfully created", r.text))
			.expect(200);
	});

	test('create_table with database param', async () => {
		await client
			.req()
			.send({ operation: 'create_table', database: 'tuckerdoodle', table: 'todo', primary_key: 'id' })
			.expect((r) => assert.equal(r.body.message, "table 'tuckerdoodle.todo' successfully created.", r.text))
			.expect(200);
	});

	test('create_table with database param (done)', async () => {
		await client
			.req()
			.send({ operation: 'create_table', database: 'tuckerdoodle', table: 'done', primary_key: 'id' })
			.expect((r) => assert.equal(r.body.message, "table 'tuckerdoodle.done' successfully created.", r.text))
			.expect(200);
	});

	test('create_table without database defaults to data schema', async () => {
		await client
			.req()
			.send({ operation: 'create_table', table: 'friends', primary_key: 'id' })
			.expect((r) => assert.equal(r.body.message, "table 'data.friends' successfully created.", r.text))
			.expect(200);
	});

	test('create_table with primary_key alias', async () => {
		await client
			.req()
			.send({ operation: 'create_table', table: 'frogs', primary_key: 'id' })
			.expect((r) => assert.equal(r.body.message, "table 'data.frogs' successfully created.", r.text))
			.expect(200);
	});

	test('create_attribute with database param', async () => {
		await client
			.req()
			.send({ operation: 'create_attribute', database: 'tuckerdoodle', table: 'todo', attribute: 'date' })
			.expect((r) => assert.equal(r.body.message, "attribute 'tuckerdoodle.todo.date' successfully created.", r.text))
			.expect(200);
	});

	test('create_attribute without database defaults to data schema', async () => {
		await client
			.req()
			.send({ operation: 'create_attribute', table: 'friends', attribute: 'name' })
			.expect((r) => assert.equal(r.body.message, "attribute 'data.friends.name' successfully created.", r.text))
			.expect(200);
	});

	// ── describe_database / describe_table ─────────────────────────────────

	test('describe_database with database param', async () => {
		await client
			.req()
			.send({ operation: 'describe_database', database: 'tuckerdoodle' })
			.expect((r) => assert.ok(r.body.hasOwnProperty('todo'), r.text))
			.expect(200);
	});

	test('describe_database without database defaults to data schema', async () => {
		await client
			.req()
			.send({ operation: 'describe_database' })
			.expect((r) => assert.ok(r.body.hasOwnProperty('friends'), r.text))
			.expect(200);
	});

	test('describe_table with database param', async () => {
		await client
			.req()
			.send({ operation: 'describe_table', database: 'tuckerdoodle', table: 'todo' })
			.expect((r) => {
				assert.equal(r.body.schema, 'tuckerdoodle', r.text);
				assert.equal(r.body.name, 'todo', r.text);
			})
			.expect(200);
	});

	test('describe_table without database defaults to data schema', async () => {
		await client
			.req()
			.send({ operation: 'describe_table', table: 'friends' })
			.expect((r) => {
				assert.equal(r.body.schema, 'data', r.text);
				assert.equal(r.body.name, 'friends', r.text);
			})
			.expect(200);
	});

	// ── insert / update / upsert / delete ──────────────────────────────────

	test('insert with database param', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				database: 'tuckerdoodle',
				table: 'todo',
				records: [{ id: 1, task: 'Get bone' }],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
			.expect(200);
	});

	test('insert without database defaults to data schema', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				table: 'friends',
				records: [
					{ id: 1, task: 'Sheriff Woody' },
					{ id: 2, task: 'Mr. Potato Head' },
				],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 2 of 2 records', r.text))
			.expect(200);
	});

	test('insert frogs for describe record_count test', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				table: 'frogs',
				records: [
					{ id: 1, type: 'bullfrog' },
					{ id: 2, type: 'toad' },
					{ id: 3, type: 'tree' },
					{ id: 4, type: 'wood' },
				],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 4 of 4 records', r.text))
			.expect(200);
	});

	test('delete with ids alias reduces record_count', async () => {
		await client
			.req()
			.send({ operation: 'delete', table: 'frogs', ids: [2] })
			.expect((r) => assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text))
			.expect(200);
	});

	test('describe_table frogs shows record_count of 3', async () => {
		await client
			.req()
			.send({ operation: 'describe_table', table: 'frogs' })
			.expect((r) => {
				assert.equal(r.body.schema, 'data', r.text);
				assert.equal(r.body.name, 'frogs', r.text);
				assert.equal(r.body.record_count, 3, r.text);
			})
			.expect(200);
	});

	test('search_by_id alias returns correct record', async () => {
		await client
			.req()
			.send({ operation: 'search_by_id', table: 'friends', ids: [1], get_attributes: ['*'] })
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	test('search_by_hash with ids alias returns correct record', async () => {
		await client
			.req()
			.send({ operation: 'search_by_hash', table: 'friends', ids: [1], get_attributes: ['*'] })
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	test('delete with ids alias', async () => {
		await client
			.req()
			.send({ operation: 'delete', table: 'friends', ids: [2] })
			.expect((r) => assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text))
			.expect(200);
	});

	test('update with database param', async () => {
		await client
			.req()
			.send({
				operation: 'update',
				database: 'tuckerdoodle',
				table: 'todo',
				records: [{ id: 1, task: 'Get extra large bone' }],
			})
			.expect((r) => assert.equal(r.body.message, 'updated 1 of 1 records', r.text))
			.expect(200);
	});

	test('update without database defaults to data schema', async () => {
		await client
			.req()
			.send({ operation: 'update', table: 'friends', records: [{ id: 1, task: 'Mr Sheriff Woody' }] })
			.expect((r) => assert.equal(r.body.message, 'updated 1 of 1 records', r.text))
			.expect(200);
	});

	test('upsert with database param', async () => {
		await client
			.req()
			.send({
				operation: 'upsert',
				database: 'tuckerdoodle',
				table: 'todo',
				records: [{ id: 2, task: 'Chase cat' }],
			})
			.expect((r) => assert.equal(r.body.message, 'upserted 1 of 1 records', r.text))
			.expect(200);
	});

	test('upsert without database defaults to data schema', async () => {
		await client
			.req()
			.send({ operation: 'upsert', table: 'friends', records: [{ id: 2, name: 'Mr Potato Head' }] })
			.expect((r) => assert.equal(r.body.message, 'upserted 1 of 1 records', r.text))
			.expect(200);
	});

	// ── search variants ─────────────────────────────────────────────────────

	test('search_by_hash without database', async () => {
		await client
			.req()
			.send({ operation: 'search_by_hash', table: 'friends', hash_values: [1], get_attributes: ['*'] })
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	test('search_by_hash with database param', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				database: 'tuckerdoodle',
				table: 'todo',
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	test('search_by_value without database', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_value',
				table: 'friends',
				search_attribute: 'task',
				search_value: '*Sheriff Woody',
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	test('search_by_value with database param', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_value',
				database: 'tuckerdoodle',
				table: 'todo',
				search_attribute: 'task',
				search_value: 'Get*',
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	test('search_by_conditions without database', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_conditions',
				table: 'friends',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'task', search_type: 'equals', search_value: 'Mr Sheriff Woody' }],
			})
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	test('search_by_conditions with database param', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_conditions',
				database: 'tuckerdoodle',
				table: 'todo',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'task', search_type: 'equals', search_value: 'Get extra large bone' }],
			})
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	// ── delete with database / hash_values ──────────────────────────────────

	test('delete with database param', async () => {
		await client
			.req()
			.send({ operation: 'delete', database: 'tuckerdoodle', table: 'todo', hash_values: [1] })
			.expect((r) => assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text))
			.expect(200);
	});

	test('delete without database defaults to data schema', async () => {
		await client
			.req()
			.send({ operation: 'delete', table: 'friends', hash_values: [1] })
			.expect((r) => assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text))
			.expect(200);
	});

	// ── drop_attribute / drop_table / drop_database ─────────────────────────

	test('drop_attribute with database param', async () => {
		await client
			.req()
			.send({ operation: 'drop_attribute', database: 'tuckerdoodle', table: 'todo', attribute: 'date' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'date'", r.text))
			.expect(200);
	});

	test('drop_attribute without database', async () => {
		await client
			.req()
			.send({ operation: 'drop_attribute', table: 'friends', attribute: 'name' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'name'", r.text))
			.expect(200);
	});

	test('drop_table with database param', async () => {
		await client
			.req()
			.send({ operation: 'drop_table', database: 'tuckerdoodle', table: 'todo' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted table 'tuckerdoodle.todo'", r.text))
			.expect(200);
	});

	test('drop_database with database param', async () => {
		await client
			.req()
			.send({ operation: 'drop_database', database: 'tuckerdoodle' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted 'tuckerdoodle'", r.text))
			.expect(200);
	});

	// ── async job operations ────────────────────────────────────────────────

	test('create job_guy database and working table for job tests', async () => {
		await client
			.req()
			.send({ operation: 'create_database', database: 'job_guy' })
			.expect((r) => assert.equal(r.body.message, "database 'job_guy' successfully created", r.text))
			.expect(200);
		await client
			.req()
			.send({ operation: 'create_table', database: 'job_guy', table: 'working', primary_key: 'id' })
			.expect((r) => assert.equal(r.body.message, "table 'job_guy.working' successfully created.", r.text))
			.expect(200);
	});

	test('delete_records_before with database param starts job', async () => {
		const r = await client
			.req()
			.send({
				operation: 'delete_records_before',
				database: 'job_guy',
				table: 'working',
				date: '2050-01-25T23:05:27.464',
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await awaitJobCompleted(client, r.body.job_id, { timeoutSeconds: JOB_TIMEOUT_SECONDS });
	});

	test('delete_records_before without database starts job', async () => {
		const r = await client
			.req()
			.send({ operation: 'delete_records_before', table: 'friends', date: '2050-01-25T23:05:27.464' })
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await awaitJobCompleted(client, r.body.job_id, { timeoutSeconds: JOB_TIMEOUT_SECONDS });
	});

	test('delete_audit_logs_before with database param starts job', async () => {
		const r = await client
			.req()
			.send({
				operation: 'delete_audit_logs_before',
				database: 'job_guy',
				table: 'working',
				timestamp: 1690553291764,
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await awaitJobCompleted(client, r.body.job_id, { timeoutSeconds: JOB_TIMEOUT_SECONDS });
	});

	test('delete_audit_logs_before without database starts job', async () => {
		const r = await client
			.req()
			.send({ operation: 'delete_audit_logs_before', table: 'friends', timestamp: 1690553291764 })
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await awaitJobCompleted(client, r.body.job_id, { timeoutSeconds: JOB_TIMEOUT_SECONDS });
	});

	test('csv_file_load with database param starts job', async () => {
		const r = await client
			.req()
			.send({
				operation: 'csv_file_load',
				database: 'job_guy',
				table: 'working',
				file_path: SUPPLIERS_CSV,
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await awaitJobCompleted(client, r.body.job_id, { timeoutSeconds: JOB_TIMEOUT_SECONDS });
	});

	test('csv_file_load without database for non-existent table returns error', async () => {
		await client
			.req()
			.send({ operation: 'csv_file_load', table: 'todo', file_path: SUPPLIERS_CSV })
			.expect((r) => assert.ok(r.body.error.includes("Table 'data.todo' does not exist"), r.text))
			.expect(400);
	});

	test('csv_file_load without database param starts job', async () => {
		const r = await client
			.req()
			.send({ operation: 'csv_file_load', table: 'friends', file_path: SUPPLIERS_CSV })
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await awaitJobCompleted(client, r.body.job_id, { timeoutSeconds: JOB_TIMEOUT_SECONDS });
	});

	test('csv_data_load without database starts job', async () => {
		const data =
			'id,name,section,country,image\n' +
			'1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://example.com/001.jpg\n' +
			'2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://example.com/002.jpg\n' +
			'3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n';
		const r = await client
			.req()
			.send({ operation: 'csv_data_load', table: 'friends', data })
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await awaitJobCompleted(client, r.body.job_id, { timeoutSeconds: JOB_TIMEOUT_SECONDS });
	});

	test('csv_data_load with database param starts job', async () => {
		const data =
			'id,name,section,country,image\n' +
			'1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://example.com/001.jpg\n';
		const r = await client
			.req()
			.send({ operation: 'csv_data_load', database: 'job_guy', table: 'working', data })
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await awaitJobCompleted(client, r.body.job_id, { timeoutSeconds: JOB_TIMEOUT_SECONDS });
	});

	test('export_local starts job', async () => {
		const r = await client
			.req()
			.send({
				operation: 'export_local',
				path: './',
				filename: 'test_export_terminology_test',
				format: 'json',
				search_operation: { operation: 'search_by_hash', table: 'friends', ids: [1], get_attributes: ['*'] },
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await awaitJobCompleted(client, r.body.job_id, { timeoutSeconds: JOB_TIMEOUT_SECONDS });
	});

	// ── final teardown ──────────────────────────────────────────────────────

	test('drop_table without database', async () => {
		await client
			.req()
			.send({ operation: 'drop_table', table: 'friends' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted table 'data.friends'", r.text))
			.expect(200);
	});

	test('drop_database job_guy', async () => {
		await client
			.req()
			.send({ operation: 'drop_database', database: 'job_guy' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted 'job_guy'", r.text))
			.expect(200);
	});
});
