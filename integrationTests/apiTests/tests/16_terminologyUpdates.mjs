import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testData, getCsvPath } from '../config/envConfig.mjs';
import { setTimeout } from 'node:timers/promises';
import { req } from '../utils/request.mjs';
import { timestamp } from '../utils/timestamp.mjs';


describe('16. Terminology Updates', () => {
	beforeEach(timestamp);
	
	//Terminology Updates Folder

	it('create_database', () => {
		return req()
			.send({ operation: 'create_database', schema: 'tuckerdoodle' })
			.expect((r) => assert.equal(r.body.message, "database 'tuckerdoodle' successfully created", r.text))
			.expect(200);
	});

	it('create_table todo with database', () => {
		return req()
			.send({ operation: 'create_table', database: 'tuckerdoodle', table: 'todo', hash_attribute: 'id' })
			.expect((r) => assert.equal(r.body.message, "table 'tuckerdoodle.todo' successfully created.", r.text))
			.expect(200);
	});

	it('create_table done with database', () => {
		return req()
			.send({ operation: 'create_table', database: 'tuckerdoodle', table: 'done', hash_attribute: 'id' })
			.expect((r) => assert.equal(r.body.message, "table 'tuckerdoodle.done' successfully created.", r.text))
			.expect(200);
	});

	it('create_table friends without database', () => {
		return req()
			.send({ operation: 'create_table', table: 'friends', hash_attribute: 'id' })
			.expect((r) => assert.equal(r.body.message, "table 'data.friends' successfully created.", r.text))
			.expect(200);
	});

	it('create_table frogs using primary_key', () => {
		return req()
			.send({ operation: 'create_table', table: 'frogs', primary_key: 'id' })
			.expect((r) => assert.equal(r.body.message, "table 'data.frogs' successfully created.", r.text))
			.expect(200);
	});

	it('create_attribute with database', () => {
		return req()
			.send({ operation: 'create_attribute', database: 'tuckerdoodle', table: 'todo', attribute: 'date' })
			.expect((r) => assert.equal(r.body.message, "attribute 'tuckerdoodle.todo.date' successfully created.", r.text))
			.expect(200);
	});

	it('create_attribute without database', () => {
		return req()
			.send({ operation: 'create_attribute', table: 'friends', attribute: 'name' })
			.expect((r) => assert.equal(r.body.message, "attribute 'data.friends.name' successfully created.", r.text))
			.expect(200);
	});

	it('describe_database with database', () => {
		return req()
			.send({ operation: 'describe_database', database: 'tuckerdoodle' })
			.expect((r) => assert.ok(r.body.hasOwnProperty('todo'), r.text))
			.expect(200);
	});

	it('describe_database without database', () => {
		return req()
			.send({ operation: 'describe_database' })
			.expect((r) => assert.ok(r.body.hasOwnProperty('friends'), r.text))
			.expect(200);
	});

	it('describe_table with database', () => {
		return req()
			.send({ operation: 'describe_table', database: 'tuckerdoodle', table: 'todo' })
			.expect((r) => assert.equal(r.body.schema, 'tuckerdoodle', r.text))
			.expect((r) => assert.equal(r.body.name, 'todo', r.text))
			.expect(200);
	});

	it('describe_table without database', () => {
		return req()
			.send({ operation: 'describe_table', table: 'friends' })
			.expect((r) => assert.equal(r.body.schema, 'data', r.text))
			.expect((r) => assert.equal(r.body.name, 'friends', r.text))
			.expect(200);
	});

	it('insert with database', () => {
		return req()
			.send({
				operation: 'insert',
				database: 'tuckerdoodle',
				table: 'todo',
				records: [{ id: 1, task: 'Get bone' }],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 1 of 1 records', r.text))
			.expect(200);
	});

	it('insert without database', () => {
		return req()
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

	it('insert table frog setup for describe', () => {
		return req()
			.send({
				operation: 'insert',
				table: 'frogs',
				records: [
					{ id: 1, type: 'bullfrog' },
					{ id: 2, type: 'toad' },
					{ id: 3, type: 'tree' },
					{
						id: 4,
						type: 'wood',
					},
				],
			})
			.expect((r) => assert.equal(r.body.message, 'inserted 4 of 4 records', r.text))
			.expect(200);
	});

	it('delete table frog setup for describe', async () => {
		await req()
			.send({ operation: 'delete', table: 'frogs', ids: [2] })
			.expect((r) => assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text))
			.expect(200);
		await setTimeout(1000);
	});

	it('describe_table frog confirm record count', () => {
		return req()
			.send({ operation: 'describe_table', table: 'frogs' })
			.expect((r) => {
				assert.equal(r.body.schema, 'data', r.text);
				assert.equal(r.body.name, 'frogs', r.text);
				assert.equal(r.body.record_count, 3, r.text);
			})
			.expect(200);
	});

	it('search_by_id', () => {
		return req()
			.send({ operation: 'search_by_id', table: 'friends', ids: [1], get_attributes: ['*'] })
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	it('search_by_hash with ids', () => {
		return req()
			.send({ operation: 'search_by_hash', table: 'friends', ids: [1], get_attributes: ['*'] })
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	it('delete with ids', () => {
		return req()
			.send({ operation: 'delete', table: 'friends', ids: [2] })
			.expect((r) => assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text))
			.expect(200);
	});

	it('update with database', () => {
		return req()
			.send({
				operation: 'update',
				database: 'tuckerdoodle',
				table: 'todo',
				records: [{ id: 1, task: 'Get extra large bone' }],
			})
			.expect((r) => assert.equal(r.body.message, 'updated 1 of 1 records', r.text))
			.expect(200);
	});

	it('update without database', () => {
		return req()
			.send({ operation: 'update', table: 'friends', records: [{ id: 1, task: 'Mr Sheriff Woody' }] })
			.expect((r) => assert.equal(r.body.message, 'updated 1 of 1 records', r.text))
			.expect(200);
	});

	it('upsert with database', () => {
		return req()
			.send({
				operation: 'upsert',
				database: 'tuckerdoodle',
				table: 'todo',
				records: [{ id: 2, task: 'Chase cat' }],
			})
			.expect((r) => assert.equal(r.body.message, 'upserted 1 of 1 records', r.text))
			.expect(200);
	});

	it('upsert without database', () => {
		return req()
			.send({ operation: 'upsert', table: 'friends', records: [{ id: 2, name: 'Mr Potato Head' }] })
			.expect((r) => assert.equal(r.body.message, 'upserted 1 of 1 records', r.text))
			.expect(200);
	});

	it('search_by_hash without database', () => {
		return req()
			.send({ operation: 'search_by_hash', table: 'friends', hash_values: [1], get_attributes: ['*'] })
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	it('search_by_hash with database', () => {
		return req()
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

	it('search_by_value without database', () => {
		return req()
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

	it('search_by_value with database', () => {
		return req()
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

	it('search_by_conditions without database', () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				table: 'friends',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'task', search_type: 'equals', search_value: 'Mr Sheriff Woody' }],
			})
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	it('search_by_conditions with database', () => {
		return req()
			.send({
				operation: 'search_by_conditions',
				database: 'tuckerdoodle',
				table: 'todo',
				get_attributes: ['*'],
				conditions: [
					{
						search_attribute: 'task',
						search_type: 'equals',
						search_value: 'Get extra large bone',
					},
				],
			})
			.expect((r) => assert.equal(r.body[0].id, 1, r.text))
			.expect(200);
	});

	it('delete with database', () => {
		return req()
			.send({ operation: 'delete', database: 'tuckerdoodle', table: 'todo', hash_values: [1] })
			.expect((r) => assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text))
			.expect(200);
	});

	it('delete without database', () => {
		return req()
			.send({ operation: 'delete', table: 'friends', hash_values: [1] })
			.expect((r) => assert.equal(r.body.message, '1 of 1 record successfully deleted', r.text))
			.expect(200);
	});

	it('drop_attribute with database', () => {
		return req()
			.send({ operation: 'drop_attribute', database: 'tuckerdoodle', table: 'todo', attribute: 'date' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'date'", r.text))
			.expect(200);
	});

	it('drop_attribute without database', () => {
		return req()
			.send({ operation: 'drop_attribute', table: 'friends', attribute: 'name' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted attribute 'name'", r.text))
			.expect(200);
	});

	it('drop_table with database', () => {
		return req()
			.send({ operation: 'drop_table', database: 'tuckerdoodle', table: 'todo' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted table 'tuckerdoodle.todo'", r.text))
			.expect(200);
	});

	it('drop_database tuckerdoodle', () => {
		return req()
			.send({ operation: 'drop_database', database: 'tuckerdoodle' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted 'tuckerdoodle'", r.text))
			.expect(200);
	});

	it('create_database "job_guy" for jobs', () => {
		return req()
			.send({ operation: 'create_database', database: 'job_guy' })
			.expect((r) => assert.equal(r.body.message, "database 'job_guy' successfully created", r.text))
			.expect(200);
	});

	it('create_table "working" for jobs', () => {
		return req()
			.send({ operation: 'create_table', database: 'job_guy', table: 'working', hash_attribute: 'id' })
			.expect((r) => assert.equal(r.body.message, "table 'job_guy.working' successfully created.", r.text))
			.expect(200);
	});

	it('delete_records_before with database', () => {
		return req()
			.send({
				operation: 'delete_records_before',
				database: 'job_guy',
				table: 'working',
				date: '2050-01-25T23:05:27.464',
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
	});

	it('delete_records_before without database', async () => {
		await req()
			.send({ operation: 'delete_records_before', table: 'friends', date: '2050-01-25T23:05:27.464' })
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await setTimeout(2000);
	});

	it('delete_audit_logs_before with database', async () => {
		await req()
			.send({
				operation: 'delete_audit_logs_before',
				database: 'job_guy',
				table: 'working',
				timestamp: 1690553291764,
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await setTimeout(5000);
	});

	it('delete_audit_logs_before without database', async () => {
		await req()
			.send({ operation: 'delete_audit_logs_before', table: 'friends', timestamp: 1690553291764 })
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
		await setTimeout(5000);
	});

	it('csv_file_load with database', () => {
		return req()
			.send({
				operation: 'csv_file_load',
				database: 'job_guy',
				table: 'working',
				file_path: `${getCsvPath()}Suppliers.csv`,
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
	});

	it('csv_file_load without database error', () => {
		return req()
			.send({ operation: 'csv_file_load', table: 'todo', file_path: `${getCsvPath()}Suppliers.csv` })
			.expect((r) => assert.ok(r.body.error.includes("Table 'data.todo' does not exist"), r.text))
			.expect(400);
	});

	it('csv_file_load without database', () => {
		return req()
			.send({ operation: 'csv_file_load', table: 'friends', file_path: `${getCsvPath()}Suppliers.csv` })
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
	});

	it('csv_data_load without database', () => {
		return req()
			.send({
				operation: 'csv_data_load',
				table: 'friends',
				data: 'id,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n',
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
	});

	it('csv_data_load with database', () => {
		return req()
			.send({
				operation: 'csv_data_load',
				database: 'job_guy',
				table: 'working',
				data: 'id,name,section,country,image\n1,ENGLISH POINTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/001g07.jpg\n2,ENGLISH SETTER,British and Irish Pointers and Setters,GREAT BRITAIN,http://www.fci.be/Nomenclature/Illustrations/002g07.jpg\n3,KERRY BLUE TERRIER,Large and medium sized Terriers,IRELAND,\n',
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
	});

	it('csv_url_load without database', () => {
		return req()
			.send({
				operation: 'csv_url_load',
				action: 'insert',
				table: 'friends',
				csv_url: 'https://harperdb-integration-test-data.s3.us-east-2.amazonaws.com/breeds.csv',
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
	});

	it('csv_url_load with database', () => {
		return req()
			.send({
				operation: 'csv_url_load',
				action: 'insert',
				database: 'job_guy',
				table: 'working',
				csv_url: 'https://harperdb-integration-test-data.s3.us-east-2.amazonaws.com/breeds.csv',
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
	});

	it('import_from_s3 without database', () => {
		return req()
			.send({
				operation: 'import_from_s3',
				table: 'friends',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/owners.json',
					region: 'us-east-2',
				},
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
	});

	it('import_from_s3 with database', () => {
		return req()
			.send({
				operation: 'import_from_s3',
				database: 'job_guy',
				table: 'working',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/owners.json',
					region: 'us-east-2',
				},
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
	});

	it('Export to S3 search_by_hash with ids', () => {
		return req()
			.send({
				operation: 'export_to_s3',
				format: 'csv',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/test_export',
					region: 'us-east-2',
				},
				search_operation: { operation: 'search_by_hash', table: 'friends', ids: [1], get_attributes: ['*'] },
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
	});

	it('Export locally search_by_hash with ids', () => {
		return req()
			.send({
				operation: 'export_local',
				path: './',
				filename: 'test_export_integration_test',
				format: 'json',
				search_operation: { operation: 'search_by_hash', table: 'friends', ids: [1], get_attributes: ['*'] },
			})
			.expect((r) => assert.ok(r.body.message.includes('Starting job with id'), r.text))
			.expect(200);
	});

	it('drop_table without database', () => {
		return req()
			.send({ operation: 'drop_table', table: 'friends' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted table 'data.friends'", r.text))
			.expect(200);
	});

	it('drop_database job_guy', () => {
		return req()
			.send({ operation: 'drop_database', database: 'job_guy' })
			.expect((r) => assert.equal(r.body.message, "successfully deleted 'job_guy'", r.text))
			.expect(200);
	});
});
