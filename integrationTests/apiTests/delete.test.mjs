/**
 * Delete operation integration tests.
 *
 * Ported from legacy `apiTests/tests/8_deleteTests.mjs`. Validates:
 * - `delete` (NoSQL) and SQL DELETE operations
 * - Delete-before semantics (insert, verify, delete)
 * - `drop_schema` / `drop_table` / `drop_attribute` operations
 * - Dropping schemas/tables with numeric-string names
 * - Insert/upsert/update/delete with attribute management
 * - SQL DELETE with numeric hash values quoted as strings
 *
 * Self-contained: starts its own Harper instance and creates all schemas it needs
 * in `before()`. The `northnwd.employees` table is created empty; tests insert
 * their own records. `dev.rando` is pre-seeded with 4 records for the SQL
 * delete tests.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';
import { awaitJob, getJobId } from './utils/operations.mjs';

suite('Delete operations', (ctx) => {
	let client;
	// Tracks the timestamp between inserts for delete_files_before tests.
	let insertTimestamp = '0';

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);

		// Create northnwd.employees — tests insert their own records.
		await client.req().send({ operation: 'create_schema', schema: 'northnwd' }).expect(200);
		await client
			.req()
			.send({ operation: 'create_table', schema: 'northnwd', table: 'employees', primary_key: 'employeeid' })
			.expect(200);

		// Create dev.rando pre-seeded for the SQL numeric-hash delete tests.
		await client.req().send({ operation: 'create_schema', schema: 'dev' }).expect(200);
		await client
			.req()
			.send({ operation: 'create_table', schema: 'dev', table: 'rando', primary_key: 'id' })
			.expect(200);
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'rando',
				records: [{ id: 987654321 }, { id: 987654322 }, { id: 987654323 }, { id: 987654324 }],
			})
			.expect(200);

		// Numeric-string schemas/tables used by the "Drop number" tests.
		// In the legacy suite these were created by 1_environmentSetup.mjs;
		// here we create them in before() so the suite is fully self-contained.
		await client.req().send({ operation: 'create_schema', schema: '123' }).expect(200);
		await client.req().send({ operation: 'create_table', schema: '123', table: '4', primary_key: 'id' }).expect(200);
		await client.req().send({ operation: 'create_schema', schema: '1123' }).expect(200);
		await client.req().send({ operation: 'create_table', schema: '1123', table: '1', primary_key: 'id' }).expect(200);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	//Delete Tests Folder

	//Delete Records Before Tests

	test('create test schema', async () => {
		await client
			.req()
			.send({ operation: 'create_schema', schema: 'test_delete_before' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		await setTimeout(500);
	});

	test('create test table', async () => {
		await client
			.req()
			.send({ operation: 'create_table', schema: 'test_delete_before', table: 'address', primary_key: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		await setTimeout(500);
	});

	//Delete Records Before Alias Tests

	test('Insert new records', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'address',
				records: [
					{ id: 1, address: '24 South st' },
					{ id: 2, address: '6 Truck Lane' },
					{
						id: 3,
						address: '19 Broadway',
					},
					{ id: 4, address: '34A Mountain View' },
					{ id: 5, address: '234 Curtis St' },
					{
						id: 6,
						address: '115 Way Rd',
					},
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 6, r.text))
			.expect(200);
		await setTimeout(1000);
	});

	test('Insert additional new records', async () => {
		insertTimestamp = new Date().toISOString();

		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'address',
				records: [
					{ id: 11, address: '24 South st' },
					{ id: 12, address: '6 Truck Lane' },
					{
						id: 13,
						address: '19 Broadway',
					},
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 3, r.text))
			.expect(200);
	});

	test('Delete records before', async () => {
		const response = await client
			.req()
			.send({
				operation: 'delete_files_before',
				date: insertTimestamp,
				schema: 'test_delete_before',
				table: 'address',
			})
			.expect(200);

		const id = getJobId(response.body);
		const jobResponse = await awaitJob(client, id, 15);
		assert.ok(jobResponse.body[0].message.includes('records successfully deleted'), jobResponse.text);
	});

	test('Search by hash confirm', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'test_delete_before',
				table: 'address',
				primary_key: 'id',
				hash_values: [1, 2, 3, 4, 5, 6, 11, 12, 13],
				get_attributes: ['id', 'address'],
			})
			.expect((r) => assert.equal(r.body.length, 3, r.text))
			.expect((r) => {
				let ids = [];

				r.body.forEach((record) => {
					ids.push(record.id);
				});

				assert.ok(ids.includes(11), r.text);
				assert.ok(ids.includes(12), r.text);
				assert.ok(ids.includes(13), r.text);

				assert.ok(!ids.includes(1), r.text);
				assert.ok(!ids.includes(2), r.text);
				assert.ok(!ids.includes(3), r.text);
				assert.ok(!ids.includes(4), r.text);
				assert.ok(!ids.includes(5), r.text);
				assert.ok(!ids.includes(6), r.text);
			})
			.expect(200);
	});

	test('Insert new records', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'address',
				records: [
					{ id: '1a', address: '24 South st' },
					{ id: '2a', address: '6 Truck Lane' },
					{
						id: '3a',
						address: '19 Broadway',
					},
					{ id: '4a', address: '34A Mountain View' },
					{ id: '5a', address: '234 Curtis St' },
					{
						id: '6a',
						address: '115 Way Rd',
					},
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 6, r.text))
			.expect(200);
		await setTimeout(1000);
	});

	test('Insert additional new records', async () => {
		insertTimestamp = new Date().toISOString();

		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'address',
				records: [
					{ id: '11a', address: '24 South st' },
					{ id: '12a', address: '6 Truck Lane' },
					{
						id: '13a',
						address: '19 Broadway',
					},
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 3, r.text))
			.expect(200);
	});

	test('Delete records before', async () => {
		const response = await client
			.req()
			.send({
				operation: 'delete_files_before',
				date: insertTimestamp,
				schema: 'test_delete_before',
				table: 'address',
			})
			.expect(200);

		const id = getJobId(response.body);
		const jobResponse = await awaitJob(client, id, 15);
		assert.ok(jobResponse.body[0].message.includes('records successfully deleted'), jobResponse.text);
	});

	test('Search by hash confirm', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'test_delete_before',
				table: 'address',
				primary_key: 'id',
				hash_values: ['1a', '2a', '3a', '4a', '5a', '6a', '11a', '12a', '13a'],
				get_attributes: ['id', 'address'],
			})
			.expect((r) => assert.equal(r.body.length, 3, r.text))
			.expect((r) => {
				let ids = [];

				r.body.forEach((record) => {
					ids.push(record.id);
				});

				assert.ok(ids.includes('11a'), r.text);
				assert.ok(ids.includes('12a'), r.text);
				assert.ok(ids.includes('13a'), r.text);

				assert.ok(!ids.includes('1a'), r.text);
				assert.ok(!ids.includes('2a'), r.text);
				assert.ok(!ids.includes('3a'), r.text);
				assert.ok(!ids.includes('4a'), r.text);
				assert.ok(!ids.includes('5a'), r.text);
				assert.ok(!ids.includes('6a'), r.text);
			})
			.expect(200);
	});

	//Drop schema tests

	test('Create schema for drop test', async () => {
		await client
			.req()
			.send({ operation: 'create_schema', schema: 'drop_schema' })
			.expect((r) => assert.equal(r.body.message, "database 'drop_schema' successfully created", r.text))
			.expect(200);
	});

	test('Create table for drop test', async () => {
		await client
			.req()
			.send({
				operation: 'create_table',
				schema: 'drop_schema',
				table: 'drop_table',
				primary_key: 'id',
			})
			.expect((r) => assert.equal(r.body.message, "table 'drop_schema.drop_table' successfully created.", r.text))
			.expect(200);
		await setTimeout(2000);
	});

	test('Insert records for drop test', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'drop_schema',
				table: 'drop_table',
				records: [
					{ id: 4, address: '194 Greenbrook Drive' },
					{
						id: 7,
						address: '195 Greenbrook Lane',
					},
					{ id: 9, address: '196 Greenbrook Lane' },
					{ id: 0, address: '197 Greenbrook Drive' },
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 4, r.text))
			.expect(200);
	});

	test('Drop schema', async () => {
		await client
			.req()
			.send({ operation: 'drop_schema', schema: 'drop_schema' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted 'drop_schema'", r.text))
			.expect(200);
	});

	test('Confirm drop schema', async () => {
		await client
			.req()
			.send({ operation: 'describe_schema', schema: 'drop_schema' })
			.expect((r) => assert.equal(r.body.error, "database 'drop_schema' does not exist", r.text))
			.expect(404);
	});

	test('Create schema again', async () => {
		await client
			.req()
			.send({ operation: 'create_schema', schema: 'drop_schema' })
			.expect((r) => assert.equal(r.body.message, "database 'drop_schema' successfully created", r.text))
			.expect(200);
	});

	test('Create table again', async () => {
		await client
			.req()
			.send({
				operation: 'create_table',
				schema: 'drop_schema',
				table: 'drop_table',
				primary_key: 'id',
			})
			.expect((r) => assert.equal(r.body.message, "table 'drop_schema.drop_table' successfully created.", r.text))
			.expect(200);
	});

	test('Confirm correct attributes', async () => {
		await client
			.req()
			.send({ operation: 'describe_table', schema: 'drop_schema', table: 'drop_table' })
			.expect((r) => {
				// try to debug/log intermittent failure here:
				if (!r.body.attributes) console.log('describe_table response', r.body);
				assert.equal(r.body.attributes.length, 3, r.text);
			})
			.expect(200);
	});

	test('Clean up after drop schema tests', async () => {
		await client
			.req()
			.send({ operation: 'drop_schema', schema: 'drop_schema' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted 'drop_schema'", r.text))
			.expect(200);
	});

	test('Create schema for wildcard test', async (t) => {
		if (process.platform === 'win32') return t.skip('Windows does not allow * in directory names');
		await client
			.req()
			.send({ operation: 'create_schema', schema: 'h*rper%1' })
			.expect((r) => assert.equal(r.body.message, "database 'h*rper%1' successfully created", r.text))
			.expect(200);
	});

	test('Drop wildcard schema', async (t) => {
		if (process.platform === 'win32') return t.skip('Windows does not allow * in directory names');
		await client
			.req()
			.send({ operation: 'drop_schema', schema: 'h*rper%1' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted 'h*rper%1'", r.text))
			.expect(200);
	});

	test('Drop number table', async () => {
		await client
			.req()
			.send({ operation: 'drop_table', schema: '123', table: '4' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted table '123.4'", r.text))
			.expect(200);
	});

	test('Drop number as string table', async () => {
		await client
			.req()
			.send({ operation: 'drop_table', schema: '1123', table: '1' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted table '1123.1'", r.text))
			.expect(200);
	});

	test('Drop number number table', async () => {
		await client
			.req()
			.send({ operation: 'drop_table', schema: 1123, table: 1 })
			.expect((r) =>
				assert.ok(JSON.stringify(r.body).includes("'schema' must be a string. 'table' must be a string"), r.text)
			)
			.expect(400);
	});

	test('Drop number schema', async () => {
		await client
			.req()
			.send({ operation: 'drop_schema', schema: '123' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted '123'", r.text))
			.expect(200);
	});

	test('Drop number as string schema', async () => {
		await client
			.req()
			.send({ operation: 'drop_schema', schema: '1123' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted '1123'", r.text))
			.expect(200);
	});

	test('Drop number number schema', async () => {
		await client
			.req()
			.send({ operation: 'drop_schema', schema: 1123 })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes("'schema' must be a string"), r.text))
			.expect(400);
	});

	//Post drop attribute tests

	test('create schema drop_attr', async () => {
		await client
			.req()
			.send({ operation: 'create_schema', schema: 'drop_attr' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
	});

	test('create table test', async () => {
		await client
			.req()
			.send({ operation: 'create_table', schema: 'drop_attr', table: 'test', primary_key: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		await setTimeout(2000);
	});

	test('Insert records into test table', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'drop_attr',
				table: 'test',
				records: [
					{ id: 1, address: '5 North Street', lastname: 'Dog', firstname: 'Harper' },
					{
						id: 2,
						address: '4 North Street',
						lastname: 'Dog',
						firstname: 'Harper',
					},
					{ id: 3, address: '3 North Street', lastname: 'Dog', firstname: 'Harper' },
					{
						id: 4,
						address: '2 North Street',
						lastname: 'Dog',
						firstname: 'Harper',
					},
					{ id: 5, address: '1 North Street', lastname: 'Dog', firstname: 'Harper' },
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 5, r.text))
			.expect((r) => assert.equal(r.body.message, 'inserted 5 of 5 records', r.text))
			.expect(200);
	});

	test('Drop attribute lastname', async () => {
		await client
			.req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	test('Upsert some values', async () => {
		await client
			.req()
			.send({
				operation: 'upsert',
				schema: 'drop_attr',
				table: 'test',
				records: [{ id: '123a', categoryid: 1, unitsnnorder: 0, unitsinstock: 39 }],
			})
			.expect((r) => {
				assert.equal(r.body.upserted_hashes.length, 1, r.text);
				assert.deepEqual(r.body.upserted_hashes, ['123a'], r.text);
				assert.equal(r.body.message, 'upserted 1 of 1 records', r.text);
			})
			.expect(200);
	});

	test('Search by hash confirm upsert', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'drop_attr',
				table: 'test',
				hash_values: ['123a'],
				get_attributes: ['*'],
			})
			.expect((r) => {
				assert.equal(r.body.length, 1, r.text);
				assert.equal(r.body[0].id, '123a', r.text);
				assert.equal(r.body[0].unitsinstock, 39, r.text);
				assert.equal(r.body[0].unitsnnorder, 0, r.text);
			})
			.expect(200);
	});

	test('Drop attribute unitsnnorder', async () => {
		await client
			.req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'unitsnnorder' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'unitsnnorder'", r.text))
			.expect(200);
	});

	test('Update some values', async () => {
		await client
			.req()
			.send({
				operation: 'update',
				schema: 'drop_attr',
				table: 'test',
				records: [{ id: 1, lastname: 'thor' }],
			})
			.expect((r) =>
				assert.equal(
					r.body.message,
					'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.equal(r.body.update_hashes.length, 1, r.text))
			.expect((r) => assert.deepEqual(r.body.update_hashes, [1], r.text))
			.expect(200);
		await setTimeout(3000);
	});

	test('Search by hash confirm update', async () => {
		await setTimeout(3000);
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'drop_attr',
				table: 'test',
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => {
				assert.equal(r.body.length, 1, r.text);
				assert.equal(r.body[0].id, 1, r.text);
				assert.equal(r.body[0].lastname, 'thor', r.text);
			})
			.expect(200);
	});

	test('Drop attribute lastname', async () => {
		await client
			.req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	test('Delete a record', async () => {
		await client
			.req()
			.send({ operation: 'delete', schema: 'drop_attr', table: 'test', hash_values: [1] })
			.expect((r) => {
				assert.equal(r.body.deleted_hashes.length, 1, r.text);
				assert.deepEqual(r.body.deleted_hashes, [1], r.text);
				assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text);
			})
			.expect(200);
	});

	test('Search by hash confirm delete', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'drop_attr',
				table: 'test',
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 0, r.text))
			.expect(200);
	});

	test('Drop schema drop_attr', async () => {
		await client
			.req()
			.send({ operation: 'drop_schema', schema: 'drop_attr' })
			.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
			.expect(200);
	});

	//Post drop attribute tests (second folder)

	test('create schema drop_attr', async () => {
		await client
			.req()
			.send({ operation: 'create_schema', schema: 'drop_attr' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
	});

	test('create table test', async () => {
		await client
			.req()
			.send({ operation: 'create_table', schema: 'drop_attr', table: 'test', primary_key: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
	});

	test('Insert records into test table', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'drop_attr',
				table: 'test',
				records: [
					{ id: 1, address: '5 North Street', lastname: 'Dog', firstname: 'Harper' },
					{
						id: 2,
						address: '4 North Street',
						lastname: 'Dog',
						firstname: 'Harper',
					},
					{ id: 3, address: '3 North Street', lastname: 'Dog', firstname: 'Harper' },
					{
						id: 4,
						address: '2 North Street',
						lastname: 'Dog',
						firstname: 'Harper',
					},
					{ id: 5, address: '1 North Street', lastname: 'Dog', firstname: 'Harper' },
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 5, r.text))
			.expect((r) => assert.equal(r.body.message, 'inserted 5 of 5 records', r.text))
			.expect(200);
	});

	test('Drop attribute lastname', async () => {
		await client
			.req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	test('Upsert some values', async () => {
		await client
			.req()
			.send({
				operation: 'upsert',
				schema: 'drop_attr',
				table: 'test',
				records: [{ id: '123a', categoryid: 1, unitsnnorder: 0, unitsinstock: 39 }],
			})
			.expect((r) => {
				assert.equal(r.body.upserted_hashes.length, 1, r.text);
				assert.deepEqual(r.body.upserted_hashes, ['123a'], r.text);
				assert.equal(r.body.message, 'upserted 1 of 1 records', r.text);
			})
			.expect(200);
	});

	test('Search by hash confirm upsert', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'drop_attr',
				table: 'test',
				hash_values: ['123a'],
				get_attributes: ['*'],
			})
			.expect((r) => {
				assert.equal(r.body.length, 1, r.text);
				assert.equal(r.body[0].id, '123a', r.text);
				assert.equal(r.body[0].unitsinstock, 39, r.text);
				assert.equal(r.body[0].unitsnnorder, 0, r.text);
			})
			.expect(200);
	});

	test('Drop attribute unitsnnorder', async () => {
		await client
			.req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'unitsnnorder' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'unitsnnorder'", r.text))
			.expect(200);
	});

	test('Update some values', async () => {
		await client
			.req()
			.send({
				operation: 'update',
				schema: 'drop_attr',
				table: 'test',
				records: [{ id: 1, lastname: 'thor' }],
			})
			.expect((r) =>
				assert.equal(
					r.body.message,
					'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.equal(r.body.update_hashes.length, 1, r.text))
			.expect((r) => assert.deepEqual(r.body.update_hashes, [1], r.text))
			.expect(200);
		await setTimeout(3000);
	});

	test('Search by hash confirm update', async () => {
		await setTimeout(3000);
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'drop_attr',
				table: 'test',
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => {
				assert.equal(r.body.length, 1, r.text);
				assert.equal(r.body[0].id, 1, r.text);
				assert.equal(r.body[0].lastname, 'thor', r.text);
			})
			.expect(200);
	});

	test('Drop attribute lastname', async () => {
		await client
			.req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	test('Delete a record', async () => {
		await client
			.req()
			.send({ operation: 'delete', schema: 'drop_attr', table: 'test', hash_values: [1] })
			.expect((r) => {
				assert.equal(r.body.deleted_hashes.length, 1, r.text);
				assert.deepEqual(r.body.deleted_hashes, [1], r.text);
				assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text);
			})
			.expect(200);
	});

	test('Search by hash confirm delete', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'drop_attr',
				table: 'test',
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 0, r.text))
			.expect(200);
	});

	test('Drop schema drop_attr', async () => {
		await client
			.req()
			.send({ operation: 'drop_schema', schema: 'drop_attr' })
			.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
			.expect(200);
	});

	//Post drop attribute tests (third folder)

	test('create schema drop_attr', async () => {
		await client
			.req()
			.send({ operation: 'create_schema', schema: 'drop_attr' })
			.expect(200)
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text));
	});

	test('create table test', async () => {
		await client
			.req()
			.send({ operation: 'create_table', schema: 'drop_attr', table: 'test', primary_key: 'id' })
			.expect(200)
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text));
		await setTimeout(2000);
	});

	test('Insert records into test table', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'drop_attr',
				table: 'test',
				records: [
					{ id: 1, address: '5 North Street', lastname: 'Dog', firstname: 'Harper' },
					{
						id: 2,
						address: '4 North Street',
						lastname: 'Dog',
						firstname: 'Harper',
					},
					{ id: 3, address: '3 North Street', lastname: 'Dog', firstname: 'Harper' },
					{
						id: 4,
						address: '2 North Street',
						lastname: 'Dog',
						firstname: 'Harper',
					},
					{ id: 5, address: '1 North Street', lastname: 'Dog', firstname: 'Harper' },
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 5, r.text))
			.expect((r) => assert.equal(r.body.message, 'inserted 5 of 5 records', r.text))
			.expect(200);
	});

	test('Drop attribute lastname', async () => {
		await client
			.req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	test('Upsert some values', async () => {
		await client
			.req()
			.send({
				operation: 'upsert',
				schema: 'drop_attr',
				table: 'test',
				records: [{ id: '123a', categoryid: 1, unitsnnorder: 0, unitsinstock: 39 }],
			})
			.expect((r) => {
				assert.equal(r.body.upserted_hashes.length, 1, r.text);
				assert.deepEqual(r.body.upserted_hashes, ['123a'], r.text);
				assert.equal(r.body.message, 'upserted 1 of 1 records', r.text);
			})
			.expect(200);
	});

	test('Search by hash confirm upsert', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'drop_attr',
				table: 'test',
				hash_values: ['123a'],
				get_attributes: ['*'],
			})
			.expect((r) => {
				assert.equal(r.body.length, 1, r.text);
				assert.equal(r.body[0].id, '123a', r.text);
				assert.equal(r.body[0].unitsinstock, 39, r.text);
				assert.equal(r.body[0].unitsnnorder, 0, r.text);
			})
			.expect(200);
	});

	test('Drop attribute unitsnnorder', async () => {
		await client
			.req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'unitsnnorder' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'unitsnnorder'", r.text))
			.expect(200);
	});

	test('Update some values', async () => {
		await client
			.req()
			.send({
				operation: 'update',
				schema: 'drop_attr',
				table: 'test',
				records: [{ id: 1, lastname: 'thor' }],
			})
			.expect((r) =>
				assert.equal(
					r.body.message,
					'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.equal(r.body.update_hashes.length, 1, r.text))
			.expect((r) => assert.deepEqual(r.body.update_hashes, [1], r.text))
			.expect(200);
		await setTimeout(3000);
	});

	test('Search by hash confirm update', async () => {
		await setTimeout(3000);
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'drop_attr',
				table: 'test',
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => {
				assert.equal(r.body.length, 1, r.text);
				assert.equal(r.body[0].id, 1, r.text);
				assert.equal(r.body[0].lastname, 'thor', r.text);
			})
			.expect(200);
	});

	test('Drop attribute lastname', async () => {
		await client
			.req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	test('Delete a record', async () => {
		await client
			.req()
			.send({ operation: 'delete', schema: 'drop_attr', table: 'test', hash_values: [1] })
			.expect((r) => {
				assert.equal(r.body.deleted_hashes.length, 1, r.text);
				assert.deepEqual(r.body.deleted_hashes, [1], r.text);
				assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text);
			})
			.expect(200);
	});

	test('Search by hash confirm delete', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'drop_attr',
				table: 'test',
				hash_values: [1],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(r.body.length, 0, r.text))
			.expect(200);
	});

	test('Drop schema drop_attr', async () => {
		await client
			.req()
			.send({ operation: 'drop_schema', schema: 'drop_attr' })
			.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
			.expect(200);
	});

	//Delete Tests Main Folder

	test('Insert new Employees', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'northnwd',
				table: 'employees',
				records: [
					{ employeeid: 924, address: '194 Greenbrook Drive' },
					{
						employeeid: 925,
						address: '195 Greenbrook Lane',
					},
					{ employeeid: 926, address: '196 Greenbrook Lane' },
					{
						employeeid: 927,
						address: '197 Greenbrook Drive',
					},
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 4, r.text))
			.expect(200);
	});

	test('Delete records ending in Lane', async () => {
		await client
			.req()
			.send({
				operation: 'sql',
				sql: `delete from ${'northnwd'}.${'employees'} where address like '%Lane'`,
			})
			.expect(200);
	});

	test('Verify records are deleted', async () => {
		await client
			.req()
			.send({
				operation: 'sql',
				sql: `SELECT *from ${'northnwd'}.${'employees'} where address like '%Lane'`,
			})
			.expect((r) => assert.equal(Array.isArray(r.body) && r.body.length, 0, r.text))
			.expect(200);
	});

	test('NoSQL Delete', async () => {
		await client
			.req()
			.send({
				operation: 'delete',
				schema: 'northnwd',
				table: 'employees',
				hash_values: [924, 927],
			})
			.expect((r) => {
				let expected_result = {
					message: '2 of 2 records successfully deleted',
					deleted_hashes: [924, 927],
					skipped_hashes: [],
				};
				assert.deepEqual(r.body, expected_result, r.text);
			})
			.expect(200);
	});

	test('NoSQL Verify records are deleted', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'northnwd',
				table: 'employees',
				hash_values: [924, 925, 926, 927],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(Array.isArray(r.body) && r.body.length, 0, r.text))
			.expect(200);
	});

	test('Insert records with objects and arrays', async () => {
		await client
			.req()
			.send({
				operation: 'insert',
				schema: 'northnwd',
				table: 'employees',
				records: [
					{
						employeeid: 7924,
						address: [
							{ height: 12, weight: 46 },
							{ shoe_size: 12, iq: 46 },
						],
					},
					{ employeeid: 7925, address: { number: 12, age: 46 } },
					{
						employeeid: 7926,
						address: { numberArray: ['1', '2', '3'], string: 'Penny' },
					},
					{ employeeid: 7927, address: ['1', '2', '3'] },
				],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 4 of 4 records', r.text))
			.expect(200);
	});

	test('Delete records containing objects and arrays', async () => {
		await client
			.req()
			.send({
				operation: 'delete',
				schema: 'northnwd',
				table: 'employees',
				hash_values: [7924, 7925, 7926, 7927],
			})
			.expect((r) => {
				let expected_result = {
					message: '4 of 4 records successfully deleted',
					deleted_hashes: [7924, 7925, 7926, 7927],
					skipped_hashes: [],
				};
				assert.deepEqual(r.body, expected_result, r.text);
			})
			.expect(200);
	});

	test('Verify object and array records deleted', async () => {
		await client
			.req()
			.send({
				operation: 'search_by_hash',
				schema: 'northnwd',
				table: 'employees',
				hash_values: [7924, 7925, 7926, 7927],
				get_attributes: ['employeeid', 'address'],
			})
			.expect((r) => assert.deepEqual(r.body, [], r.text))
			.expect(200);
	});

	test('test SQL deleting with numeric hash in single quotes', async () => {
		await client
			.req()
			.send({ operation: 'sql', sql: "DELETE FROM dev.rando WHERE id IN ('987654321', '987654322')" })
			.expect((r) => assert.ok(r.body.message.includes('2 of 2 records successfully deleted'), r.text))
			.expect((r) =>
				assert.ok(r.body.deleted_hashes.includes(987654321) && r.body.deleted_hashes.includes(987654322), r.text)
			)
			.expect(200);
	});

	test('test SQL deleting with numeric no condition', async () => {
		await client
			.req()
			.send({ operation: 'sql', sql: 'DELETE FROM dev.rando' })
			.expect((r) => assert.ok(r.body.message.includes('2 of 2 records successfully deleted'), r.text))
			.expect((r) =>
				assert.ok(r.body.deleted_hashes.includes(987654323) && r.body.deleted_hashes.includes(987654324), r.text)
			)
			.expect(200);
	});
});
