import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testData } from '../config/envConfig.js';
import { checkJob, getJobId } from '../utils/jobs.js';
import { setTimeout } from 'node:timers/promises';
import { req } from '../utils/request.js';

describe('8. Delete Tests', () => {
	//Delete Tests Folder

	//Delete Records Before Tests

	it('create test schema', async () => {
		await req()
			.send({ operation: 'create_schema', schema: 'test_delete_before' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		await setTimeout(500);
	});

	it('create test table', async () => {
		await req()
			.send({ operation: 'create_table', schema: 'test_delete_before', table: 'address', hash_attribute: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		await setTimeout(500);
	});

	//Delete Records Before Alias Tests

	it('Insert new records', async () => {
		await req()
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

	it('Insert additional new records', () => {
		testData.insert_timestamp = new Date().toISOString();

		return req()
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

	it('Delete records before', async () => {
		const response = await req()
			.send({
				operation: 'delete_files_before',
				date: `${testData.insert_timestamp}`,
				schema: 'test_delete_before',
				table: 'address',
			})
			.expect(200);

		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);
		assert.ok(jobResponse.body[0].message.includes('records successfully deleted'), jobResponse.text);
	});

	it('Search by hash confirm', () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: 'test_delete_before',
				table: 'address',
				hash_attribute: 'id',
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

	it('Insert new records', async () => {
		await req()
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

	it('Insert additional new records', () => {
		testData.insert_timestamp = new Date().toISOString();

		return req()
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

	it('Delete records before', async () => {
		const response = await req()
			.send({
				operation: 'delete_files_before',
				date: `${testData.insert_timestamp}`,
				schema: 'test_delete_before',
				table: 'address',
			})
			.expect(200);

		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);
		assert.ok(jobResponse.body[0].message.includes('records successfully deleted'), jobResponse.text);
	});

	it('Search by hash confirm', () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: 'test_delete_before',
				table: 'address',
				hash_attribute: 'id',
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

	it('Create schema for drop test', () => {
		return req()
			.send({ operation: 'create_schema', schema: `${testData.drop_schema}` })
			.expect((r) => assert.equal(r.body.message, "database 'drop_schema' successfully created", r.text))
			.expect(200);
	});

	it('Create table for drop test', async () => {
		await req()
			.send({
				operation: 'create_table',
				schema: `${testData.drop_schema}`,
				table: `${testData.drop_table}`,
				hash_attribute: 'id',
			})
			.expect((r) => assert.equal(r.body.message, "table 'drop_schema.drop_table' successfully created.", r.text))
			.expect(200);
		await setTimeout(2000);
	});

	it('Insert records for drop test', () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.drop_schema}`,
				table: `${testData.drop_table}`,
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

	it('Drop schema', () => {
		return req()
			.send({ operation: 'drop_schema', schema: `${testData.drop_schema}` })
			.expect((r) => assert.equal(r.body.message, "successfully deleted 'drop_schema'", r.text))
			.expect(200);
	});

	it('Confirm drop schema', () => {
		return req()
			.send({ operation: 'describe_schema', schema: `${testData.drop_schema}` })
			.expect((r) => assert.equal(r.body.error, "database 'drop_schema' does not exist", r.text))
			.expect(404);
	});

	it('Create schema again', () => {
		return req()
			.send({ operation: 'create_schema', schema: `${testData.drop_schema}` })
			.expect((r) => assert.equal(r.body.message, "database 'drop_schema' successfully created", r.text))
			.expect(200);
	});

	it('Create table again', async () => {
		await req()
			.send({
				operation: 'create_table',
				schema: `${testData.drop_schema}`,
				table: `${testData.drop_table}`,
				hash_attribute: 'id',
			})
			.expect((r) => assert.equal(r.body.message, "table 'drop_schema.drop_table' successfully created.", r.text))
			.expect(200);
		await setTimeout(2000);
	});

	it('Confirm correct attributes', () => {
		return req()
			.send({ operation: 'describe_table', schema: `${testData.drop_schema}`, table: `${testData.drop_table}` })
			.expect((r) => {
				// try to debug/log intermittent failure here:
				if (!r.body.attributes) console.log('describe_table response', r.body);
				assert.equal(r.body.attributes.length, 3, r.text);
			})
			.expect(200);
	});

	it('Clean up after drop schema tests', () => {
		return req()
			.send({ operation: 'drop_schema', schema: `${testData.drop_schema}` })
			.expect((r) => assert.equal(r.body.message, "successfully deleted 'drop_schema'", r.text))
			.expect(200);
	});

	it('Create schema for wildcard test', () => {
		return req()
			.send({ operation: 'create_schema', schema: 'h*rper%1' })
			.expect((r) => assert.equal(r.body.message, "database 'h*rper%1' successfully created", r.text))
			.expect(200);
	});

	it('Drop wildcard schema', () => {
		return req()
			.send({ operation: 'drop_schema', schema: 'h*rper%1' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted 'h*rper%1'", r.text))
			.expect(200);
	});

	it('Drop number table', () => {
		return req()
			.send({ operation: 'drop_table', schema: '123', table: '4' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted table '123.4'", r.text))
			.expect(200);
	});

	it('Drop number as string table', () => {
		return req()
			.send({ operation: 'drop_table', schema: '1123', table: '1' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted table '1123.1'", r.text))
			.expect(200);
	});

	it('Drop number number table', () => {
		return req()
			.send({ operation: 'drop_table', schema: 1123, table: 1 })
			.expect((r) =>
				assert.ok(JSON.stringify(r.body).includes("'schema' must be a string. 'table' must be a string"), r.text)
			)
			.expect(400);
	});

	it('Drop number schema', () => {
		return req()
			.send({ operation: 'drop_schema', schema: '123' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted '123'", r.text))
			.expect(200);
	});

	it('Drop number as string schema', () => {
		return req()
			.send({ operation: 'drop_schema', schema: '1123' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted '1123'", r.text))
			.expect(200);
	});

	it('Drop number number schema', () => {
		return req()
			.send({ operation: 'drop_schema', schema: 1123 })
			.expect((r) => assert.ok(JSON.stringify(r.body).includes("'schema' must be a string"), r.text))
			.expect(400);
	});

	//Post drop attribute tests

	it('create schema drop_attr', () => {
		return req()
			.send({ operation: 'create_schema', schema: 'drop_attr' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
	});

	it('create table test', async () => {
		await req()
			.send({ operation: 'create_table', schema: 'drop_attr', table: 'test', hash_attribute: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		await setTimeout(2000);
	});

	it('Insert records into test table', () => {
		return req()
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

	it('Drop attribute lastname', () => {
		return req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	it('Upsert some values', () => {
		return req()
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

	it('Search by hash confirm upsert', () => {
		return req()
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

	it('Drop attribute unitsnnorder', () => {
		return req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'unitsnnorder' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'unitsnnorder'", r.text))
			.expect(200);
	});

	it('Update some values', async () => {
		await req()
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

	it('Search by hash confirm update', async () => {
		await setTimeout(3000);
		return req()
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

	it('Drop attribute lastname', () => {
		return req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	it('Delete a record', () => {
		return req()
			.send({ operation: 'delete', schema: 'drop_attr', table: 'test', hash_values: [1] })
			.expect((r) => {
				assert.equal(r.body.deleted_hashes.length, 1, r.text);
				assert.deepEqual(r.body.deleted_hashes, [1], r.text);
				assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text);
			})
			.expect(200);
	});

	it('Search by hash confirm delete', () => {
		return req()
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

	it('Drop schema drop_attr', () => {
		return req()
			.send({ operation: 'drop_schema', schema: 'drop_attr' })
			.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
			.expect(200);
	});

	//Post drop attribute tests (second folder)

	it('create schema drop_attr', () => {
		return req()
			.send({ operation: 'create_schema', schema: 'drop_attr' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
	});

	it('create table test', () => {
		return req()
			.send({ operation: 'create_table', schema: 'drop_attr', table: 'test', hash_attribute: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
	});

	it('Insert records into test table', () => {
		return req()
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

	it('Drop attribute lastname', () => {
		return req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	it('Upsert some values', () => {
		return req()
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

	it('Search by hash confirm upsert', () => {
		return req()
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

	it('Drop attribute unitsnnorder', () => {
		return req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'unitsnnorder' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'unitsnnorder'", r.text))
			.expect(200);
	});

	it('Update some values', async () => {
		await req()
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

	it('Search by hash confirm update', async () => {
		await setTimeout(3000);
		return req()
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

	it('Drop attribute lastname', () => {
		return req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	it('Delete a record', () => {
		return req()
			.send({ operation: 'delete', schema: 'drop_attr', table: 'test', hash_values: [1] })
			.expect((r) => {
				assert.equal(r.body.deleted_hashes.length, 1, r.text);
				assert.deepEqual(r.body.deleted_hashes, [1], r.text);
				assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text);
			})
			.expect(200);
	});

	it('Search by hash confirm delete', () => {
		return req()
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

	it('Drop schema drop_attr', () => {
		return req()
			.send({ operation: 'drop_schema', schema: 'drop_attr' })
			.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
			.expect(200);
	});

	//Post drop attribute tests (third folder)

	it('create schema drop_attr', () => {
		return req()
			.send({ operation: 'create_schema', schema: 'drop_attr' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
	});

	it('create table test', async () => {
		await req()
			.send({ operation: 'create_table', schema: 'drop_attr', table: 'test', hash_attribute: 'id' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		await setTimeout(2000);
	});

	it('Insert records into test table', () => {
		return req()
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

	it('Drop attribute lastname', () => {
		return req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	it('Upsert some values', () => {
		return req()
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

	it('Search by hash confirm upsert', () => {
		return req()
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

	it('Drop attribute unitsnnorder', () => {
		return req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'unitsnnorder' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'unitsnnorder'", r.text))
			.expect(200);
	});

	it('Update some values', async () => {
		await req()
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

	it('Search by hash confirm update', async () => {
		await setTimeout(3000);
		await req()
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

	it('Drop attribute lastname', () => {
		return req()
			.send({ operation: 'drop_attribute', schema: 'drop_attr', table: 'test', attribute: 'lastname' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'lastname'", r.text))
			.expect(200);
	});

	it('Delete a record', () => {
		return req()
			.send({ operation: 'delete', schema: 'drop_attr', table: 'test', hash_values: [1] })
			.expect((r) => {
				assert.equal(r.body.deleted_hashes.length, 1, r.text);
				assert.deepEqual(r.body.deleted_hashes, [1], r.text);
				assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text);
			})
			.expect(200);
	});

	it('Search by hash confirm delete', () => {
		return req()
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

	it('Drop schema drop_attr', () => {
		return req()
			.send({ operation: 'drop_schema', schema: 'drop_attr' })
			.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
			.expect(200);
	});

	//Delete Tests Main Folder

	it('Insert new Employees', () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
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

	it('Delete records ending in Lane', () => {
		return req()
			.send({
				operation: 'sql',
				sql: `delete from ${testData.schema}.${testData.emps_tb} where address like '%Lane'`,
			})
			.expect(200);
	});

	it('Verify records are deleted', () => {
		return req()
			.send({
				operation: 'sql',
				sql: `SELECT *from ${testData.schema}.${testData.emps_tb} where address like '%Lane'`,
			})
			.expect((r) => assert.equal(Array.isArray(r.body) && r.body.length, 0, r.text))
			.expect(200);
	});

	it('NoSQL Delete', () => {
		return req()
			.send({
				operation: 'delete',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
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

	it('NoSQL Verify records are deleted', () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_values: [924, 925, 926, 927],
				get_attributes: ['*'],
			})
			.expect((r) => assert.equal(Array.isArray(r.body) && r.body.length, 0, r.text))
			.expect(200);
	});

	it('Insert records with objects and arrays', () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
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

	it('Delete records containing objects and arrays', () => {
		return req()
			.send({
				operation: 'delete',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
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

	it('Verify object and array records deleted', () => {
		return req()
			.send({
				operation: 'search_by_hash',
				schema: `${testData.schema}`,
				table: `${testData.emps_tb}`,
				hash_values: [7924, 7925, 7926, 7925],
				get_attributes: ['employeeid', 'address'],
			})
			.expect((r) => assert.deepEqual(r.body, [], r.text))
			.expect(200);
	});

	it('test SQL deleting with numeric hash in single quotes', () => {
		return req()
			.send({ operation: 'sql', sql: "DELETE FROM dev.rando WHERE id IN ('987654321', '987654322')" })
			.expect((r) => assert.ok(r.body.message.includes('2 of 2 records successfully deleted'), r.text))
			.expect((r) =>
				assert.ok(r.body.deleted_hashes.includes(987654321) && r.body.deleted_hashes.includes(987654322), r.text)
			)
			.expect(200);
	});

	it('test SQL deleting with numeric no condition', () => {
		return req()
			.send({ operation: 'sql', sql: 'DELETE FROM dev.rando' })
			.expect((r) => assert.ok(r.body.message.includes('2 of 2 records successfully deleted'), r.text))
			.expect((r) =>
				assert.ok(r.body.deleted_hashes.includes(987654323) && r.body.deleted_hashes.includes(987654324), r.text)
			)
			.expect(200);
	});
});
