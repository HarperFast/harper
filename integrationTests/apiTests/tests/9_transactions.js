import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, generic, headers } from '../config/envConfig.js';
import { checkJob, getJobId } from '../utils/jobs.js';
import { setTimeout } from 'node:timers/promises';

describe('9. Transactions', () => {


	//Transactions Folder


	//Delete Audit Logs Before Tests

	it('create test table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'create_table',
				schema: 'test_delete_before',
				table: 'testerama',
				hash_attribute: 'id',
			})
			.expect((r) => assert.ok(r.body.message.includes('successfully created')))
			.expect(200);
		await setTimeout(500);
	});

	it('Insert new records', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'testerama',
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
			.expect((r) => assert.ok(r.body.inserted_hashes.length == 6))
			.expect(200);
		await setTimeout(1000);
	});

	it('Insert additional new records', async () => {
		generic.insert_timestamp = new Date().getTime();
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'testerama',
				records: [
					{ id: 11, address: '24 South st' },
					{ id: 12, address: '6 Truck Lane' },
					{ id: 13, address: '19 Broadway'},
				],
			})
			.expect((r) => assert.ok(r.body.inserted_hashes.length == 3))
			.expect(200);
	});

	it('Delete records before', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'delete_audit_logs_before',
				timestamp: `${generic.insert_timestamp}`,
				schema: 'test_delete_before',
				table: 'testerama',
			})
			.expect(200);

		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);
		assert.ok(jobResponse.body[0].message.includes('Successfully completed'));
	});


	//Read Transaction Logs

	it('create test table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'create_table',
				schema: 'test_delete_before',
				table: 'test_read',
				hash_attribute: 'id',
			})
			.expect((r) => assert.ok(r.body.message.includes('successfully created')))
			.expect(200);
		await setTimeout(500);
	});

	it('Insert new records', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'test_read',
				records: [
					{ id: 1, name: 'Penny' },
					{ id: 2, name: 'Kato', age: 6 },
				],
			})
			.expect((r) => assert.ok(r.body.inserted_hashes.length == 2))
			.expect(200);
		await setTimeout(100);
	});

	it('Insert more records', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'test_read',
				records: [{ id: 3, name: 'Riley', age: 7 }],
			})
			.expect((r) => assert.ok(r.body.inserted_hashes.length == 1))
			.expect(200);
		await setTimeout(100);
	});

	it('Update records', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'update',
				schema: 'test_delete_before',
				table: 'test_read',
				records: [
					{ id: 1, name: 'Penny B', age: 8 },
					{ id: 2, name: 'Kato B' },
				],
			})
			.expect((r) => assert.ok(r.body.update_hashes.length == 2))
			.expect(200);
		await setTimeout(100);
	});

	it('Insert another record', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'test_read',
				records: [{ id: 'blerrrrr', name: 'Rosco' }],
			})
			.expect((r) => assert.ok(r.body.inserted_hashes.length == 1))
			.expect(200);
		await setTimeout(100);
	});

	it('Update a record', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'update',
				schema: 'test_delete_before',
				table: 'test_read',
				records: [{ id: 'blerrrrr', breed: 'Mutt' }],
			})
			.expect((r) => assert.ok(r.body.update_hashes.length == 1))
			.expect(200);
		await setTimeout(100);
	});

	it('Delete some records', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'delete', schema: 'test_delete_before', table: 'test_read', hash_values: [3, 1] })
			.expect((r) => assert.ok(r.body.deleted_hashes.length == 2))
			.expect(200);
		await setTimeout(100);
	});

	it('Insert another record', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				schema: 'test_delete_before',
				table: 'test_read',
				records: [{ id: 4, name: 'Griff' }],
			})
			.expect((r) => assert.ok(r.body.inserted_hashes.length == 1))
			.expect(200);
		await setTimeout(100);
	});

	it('Upsert records', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'upsert',
				schema: 'test_delete_before',
				table: 'test_read',
				records: [
					{ id: 4, name: 'Griffy Jr.' },
					{ id: 5, name: 'Gizmo', age: 10 },
					{ name: 'Moe', age: 11 },
				],
			})
			.expect((r) => assert.ok(r.body.upserted_hashes.length == 3))
			.expect(200);
		await setTimeout(100);
	});

	it('Check upsert transaction', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'read_audit_log',
				schema: 'test_delete_before',
				table: 'test_read',
				search_type: 'hash_value',
				search_values: [5],
			})
			.expect((r) => {
				assert.ok(r.body['5'].length == 1);
				const transaction = r.body['5'][0];
				assert.ok(transaction.operation == 'upsert');
				assert.ok(transaction.records.length == 1);
				Object.keys(transaction.records[0]).forEach((key) => {
					assert.ok(['id', 'name', 'age', '__updatedtime__', '__createdtime__'].includes(key));
				});
			});
		await setTimeout(100);
	});

	it('Fetch all Transactions', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'read_audit_log', schema: 'test_delete_before', table: 'test_read' })
			.expect((r) => {
				assert.ok(r.body.length == 8);

				const expected_attrs = ['id', 'name', '__updatedtime__'];
				const other_attrs = ['age', '__createdtime__'];

				const upsert_trans = r.body[7];

				assert.ok(upsert_trans.operation == 'upsert');
				assert.ok(upsert_trans.records.length == 3);

				assert.ok(upsert_trans.records[0].id == 4);
				Object.keys(upsert_trans.records[0]).forEach((key) => {
					assert.ok([...expected_attrs, ...other_attrs].includes(key));
				});

				assert.ok(upsert_trans.records[1].id == 5);
				Object.keys(upsert_trans.records[1]).forEach((key) => {
					assert.ok([...expected_attrs, ...other_attrs].includes(key));
				});

				assert.ok(typeof upsert_trans.records[2].id == 'number');
				Object.keys(upsert_trans.records[2]).forEach((key) => {
					assert.ok([...expected_attrs, ...other_attrs].includes(key));
				});
			});
		await setTimeout(100);
	});

	it('Fetch timestamp Transactions', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'read_audit_log',
				schema: 'test_delete_before',
				table: 'test_read',
				search_type: 'timestamp',
				search_values: [],
			})
			.expect((r) => assert.ok(r.body.length == 8))
			.expect(200);
		await setTimeout(100);
	});

	it('Fetch user transactions', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'read_audit_log',
				schema: 'test_delete_before',
				table: 'test_read',
				search_type: 'username',
				search_values: [`${generic.username}`],
			})
			.expect((r) => assert.ok(r.body[generic.username].length == 8))
			.expect(200);
		await setTimeout(100);
	});

	it('Fetch hash transactions', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'read_audit_log',
				schema: 'test_delete_before',
				table: 'test_read',
				search_type: 'hash_value',
				search_values: [1, 'blerrrrr'],
			})
			.expect((r) => assert.ok(r.body['1'].length == 3))
			.expect((r) => assert.ok(r.body['blerrrrr'].length == 2))
			.expect(200);
		await setTimeout(100);
	});

	it('drop test_read table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_table', schema: 'test_delete_before', table: 'test_read' })
			.expect(200);
		await setTimeout(500);
	});
});
