import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dateTomorrow, dateYesterday, testData, getCsvPath, headersTestUser } from '../config/envConfig.mjs';
import { checkJob, checkJobCompleted, getJobId } from '../utils/jobs.mjs';
import { setTimeout } from 'node:timers/promises';
import { req, reqAsNonSU } from '../utils/request.mjs';

describe('7. Jobs & Job Role Testing', () => {
	//Jobs & Job Role Testing Folder

	//S3 Operations

	it('Create schema for S3 test', () => {
		return req().send({ operation: 'create_schema', schema: 'S3_DATA' }).expect(200);
	});

	it('Create dogs table for S3 test', () => {
		return req()
			.send({ operation: 'create_table', schema: 'S3_DATA', table: 'dogs', hash_attribute: 'id' })
			.expect(200);
	});

	it('Create breed table for S3 test', () => {
		return req()
			.send({ operation: 'create_table', schema: 'S3_DATA', table: 'breed', hash_attribute: 'id' })
			.expect(200);
	});

	it('Create owners table for S3 test', () => {
		return req()
			.send({ operation: 'create_table', schema: 'S3_DATA', table: 'owners', hash_attribute: 'id' })
			.expect(200);
	});

	it('Create sensor table for S3 test', () => {
		return req()
			.send({ operation: 'create_table', schema: 'S3_DATA', table: 'sensor', hash_attribute: 'id' })
			.expect(200);
	});

	it('Import dogs.xlsx from S3 - expect error', () => {
		return req()
			.send({
				operation: 'import_from_s3',
				action: 'insert',
				schema: 'S3_DATA',
				table: 'dogs',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/dogs.xlsx',
					region: 'us-east-2',
				},
			})
			.expect((r) =>
				assert.equal(
					r.body.error,
					"S3 key must include one of the following valid file extensions - '.csv', '.json'",
					r.text
				)
			)
			.expect(400);
	});

	it('Import dogs.csv from S3', async () => {
		const response = await req()
			.send({
				operation: 'import_from_s3',
				action: 'insert',
				schema: 'S3_DATA',
				table: 'dogs',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/dogs.csv',
					region: 'us-east-2',
				},
			})
			.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text))
			.expect(200);

		const id = await getJobId(response.body);
		return checkJobCompleted(id, '', 'successfully loaded 12 of 12 records');
	});

	it('Import owners.json from S3', async () => {
		const response = await req()
			.send({
				operation: 'import_from_s3',
				action: 'insert',
				schema: 'S3_DATA',
				table: 'owners',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/owners.json',
					region: 'us-east-2',
				},
			})
			.expect(200);

		const id = await getJobId(response.body);
		return checkJobCompleted(id, '', 'successfully loaded 4 of 4 records');
	});

	it('Import breed.json from S3', async () => {
		const response = await req()
			.send({
				operation: 'import_from_s3',
				action: 'insert',
				schema: 'S3_DATA',
				table: 'breed',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/breed.json',
					region: 'us-east-2',
				},
			})
			.expect(200);

		const id = await getJobId(response.body);
		return checkJobCompleted(id, '', 'successfully loaded 350 of 350 records');
	});

	it('Import does_not_exist.csv from S3 - expect fail', async () => {
		const response = await req()
			.send({
				operation: 'import_from_s3',
				action: 'insert',
				schema: 'S3_DATA',
				table: 'owners',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/does_not_exist.csv',
					region: 'us-east-2',
				},
			})
			.expect(200);

		const id = await getJobId(response.body);
		return checkJobCompleted(id, 'The specified key does not exist.');
	});

	it('Import dogs_update.csv from S3', async () => {
		const response = await req()
			.send({
				operation: 'import_from_s3',
				action: 'update',
				schema: 'S3_DATA',
				table: 'dogs',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/dogs_update.csv',
					region: 'us-east-2',
				},
			})
			.expect(200);

		const id = await getJobId(response.body);
		return checkJobCompleted(id, '', 'successfully loaded 12 of 12 records');
	});

	it('Import owners_update.json from S3', async () => {
		const response = await req()
			.send({
				operation: 'import_from_s3',
				action: 'update',
				schema: 'S3_DATA',
				table: 'owners',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/owners_update.json',
					region: 'us-east-2',
				},
			})
			.expect(200);

		const id = await getJobId(response.body);
		return checkJobCompleted(id, '', 'successfully loaded 4 of 4 records');
	});

	it('Import large sensor_data.json from S3', async () => {
		const response = await req()
			.send({
				operation: 'import_from_s3',
				action: 'insert',
				schema: 'S3_DATA',
				table: 'sensor',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/sensor_data.json',
					region: 'us-east-2',
				},
			})
			.expect(200);

		const id = await getJobId(response.body);
		return checkJobCompleted(id, '', 'successfully loaded 20020 of 20020 records');
	});

	it('Import large sensor_data.json for UPSERT from S3', async () => {
		const response = await req()
			.send({
				operation: 'import_from_s3',
				action: 'upsert',
				schema: 'S3_DATA',
				table: 'sensor',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/sensor_data.json',
					region: 'us-east-2',
				},
			})
			.expect(200);

		const id = await getJobId(response.body);
		return checkJobCompleted(id, '', 'successfully loaded 20020 of 20020 records');
	});

	it('Check rows from S3 upsert were updated', () => {
		return req()
			.send({ operation: 'sql', sql: 'SELECT * FROM S3_DATA.sensor' })
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.__updatedtime__ > row.__createdtime__, r.text);
				});
			})
			.expect(200);
	});

	it('Import does_not_exist_UPDATE.csv from S3 - expect fail', async () => {
		const response = await req()
			.send({
				operation: 'import_from_s3',
				action: 'update',
				schema: 'S3_DATA',
				table: 'owners',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/does_not_exist_UPDATE.csv',
					region: 'us-east-2',
				},
			})
			.expect(200);

		const id = await getJobId(response.body);
		return checkJobCompleted(id, 'The specified key does not exist.', '');
	});

	it('Export to S3', async () => {
		const response = await req()
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
				search_operation: { operation: 'sql', sql: 'SELECT * FROM S3_DATA.dogs LIMIT 1' },
			})
			.expect(200);

		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);

		assert.ok(jobResponse.body[0].result.ETag, jobResponse.text);
		assert.ok(jobResponse.body[0].result.VersionId, jobResponse.text);
	});

	it('Export to S3 search_by_conditions', async () => {
		const response = await req()
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
				search_operation: {
					operation: 'search_by_conditions',
					database: 'S3_DATA',
					table: 'dogs',
					operator: 'and',
					get_attributes: ['*'],
					conditions: [{ search_attribute: 'breed_id', search_type: 'between', search_value: [199, 280] }],
				},
			})
			.expect(200);

		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);

		assert.ok(jobResponse.body[0].result.ETag, jobResponse.text);
		assert.ok(jobResponse.body[0].result.VersionId, jobResponse.text);
	});

	it('Export local search_by_conditions', async () => {
		const response = await req()
			.send({
				operation: 'export_local',
				path: './',
				format: 'json',
				filename: 'integration-test',
				search_operation: {
					operation: 'search_by_conditions',
					database: 'S3_DATA',
					table: 'dogs',
					operator: 'and',
					get_attributes: ['*'],
					conditions: [{ search_attribute: 'breed_id', search_type: 'between', search_value: [199, 200] }],
				},
			})
			.expect(200);

		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);

		assert.equal(jobResponse.body[0].result.message, 'Successfully exported JSON locally.', jobResponse.text);
		assert.equal(jobResponse.body[0].type, 'export_local', jobResponse.text);
	});

	it('Create S3 test table', () => {
		return req()
			.send({ operation: 'create_table', schema: 'S3_DATA', table: 's3_test', hash_attribute: 'id' })
			.expect(200);
	});

	it('Create S3 CSV import test table', () => {
		return req()
			.send({ operation: 'create_table', schema: 'S3_DATA', table: 's3_test_csv_import', hash_attribute: 'id' })
			.expect(200);
	});

	it('Create S3 JSON import test table', () => {
		return req()
			.send({
				operation: 'create_table',
				schema: 'S3_DATA',
				table: 's3_test_json_import',
				hash_attribute: 'id',
			})
			.expect(200);
	});

	it('Insert records S3 test table', () => {
		return req()
			.send({
				operation: 'insert',
				schema: 'S3_DATA',
				table: 's3_test',
				records: [
					{
						id: 'a',
						address: '1 North Street',
						lastname: 'Dog',
						firstname: 'Harper',
						one: 'only one',
					},
					{
						id: 'b',
						object: { name: 'object', number: 1, array: [1, 'two'] },
						array: [1, 2, 'three'],
						firstname: 'Harper',
					},
					{ id: 'c', object_array: [{ number: 1 }, { number: 'two', count: 2 }] },
				],
			})
			.expect((r) => assert.equal(r.body.inserted_hashes.length, 3, r.text))
			.expect((r) => assert.equal(r.body.message, 'inserted 3 of 3 records', r.text))
			.expect(200);
	});

	it('Export S3 test table CSV', async () => {
		const response = await req()
			.send({
				operation: 'export_to_s3',
				format: 'csv',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/test_export_csv',
					region: 'us-east-2',
				},
				search_operation: { operation: 'sql', sql: 'SELECT * FROM S3_DATA.s3_test' },
			})
			.expect(200);

		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);

		assert.ok(jobResponse.body[0].result.ETag, jobResponse.text);
		assert.ok(jobResponse.body[0].result.VersionId, jobResponse.text);
	});

	it('Import S3 test table CSV', async () => {
		const response = await req()
			.send({
				operation: 'import_from_s3',
				action: 'insert',
				schema: 'S3_DATA',
				table: 's3_test_csv_import',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/test_export_csv.csv',
					region: 'us-east-2',
				},
			})
			.expect(200);

		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);

		assert.ok(jobResponse.body[0].message.includes('successfully loaded'), jobResponse.text);
	});

	it('Confirm CSV records import', () => {
		return req()
			.send({
				operation: 'sql',
				sql: 'select `one`, `object_array`, `id`, `address`, `object`, `lastname`, `firstname`, `array` FROM S3_DATA.s3_test_csv_import ORDER BY id ASC',
			})
			.expect((r) => {
				let expected_res = [
					{
						one: 'only one',
						object_array: '',
						id: 'a',
						address: '1 North Street',
						object: '',
						lastname: 'Dog',
						firstname: 'Harper',
						array: '',
					},
					{
						one: '',
						object_array: '',
						id: 'b',
						address: '',
						object: {
							name: 'object',
							number: 1,
							array: [1, 'two'],
						},
						lastname: '',
						firstname: 'Harper',
						array: [1, 2, 'three'],
					},
					{
						one: '',
						object_array: [
							{
								number: 1,
							},
							{
								number: 'two',
								count: 2,
							},
						],
						id: 'c',
						address: '',
						object: '',
						lastname: '',
						firstname: '',
						array: '',
					},
				];
				assert.deepEqual(r.body, expected_res, r.text);
			})
			.expect(200);
	});

	it('Export S3 test table JSON', async () => {
		const response = await req()
			.send({
				operation: 'export_to_s3',
				format: 'json',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/test_export_json',
					region: 'us-east-2',
				},
				search_operation: { operation: 'sql', sql: 'SELECT * FROM S3_DATA.s3_test' },
			})
			.expect(200);

		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);

		assert.ok(jobResponse.body[0].result.ETag, jobResponse.text);
	});

	it('Import S3 test table JSON', async () => {
		const response = await req()
			.send({
				operation: 'import_from_s3',
				action: 'insert',
				schema: 'S3_DATA',
				table: 's3_test_json_import',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/test_export_json.json',
					region: 'us-east-2',
				},
			})
			.expect(200);
		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);

		assert.ok(jobResponse.body[0].message.includes('successfully loaded'), jobResponse.text);
	});

	it('Confirm JSON records import', async () => {
		const response = await req()
			.send({
				operation: 'sql',
				sql: 'select `one`, `object_array`, `id`, `address`, `object`, `lastname`, `firstname`, `array` FROM S3_DATA.s3_test_csv_import ORDER BY id ASC',
			})
			.expect(200);

		let expected_res = [
			{
				one: 'only one',
				object_array: '',
				id: 'a',
				address: '1 North Street',
				object: '',
				lastname: 'Dog',
				firstname: 'Harper',
				array: '',
			},
			{
				one: '',
				object_array: '',
				id: 'b',
				address: '',
				object: {
					name: 'object',
					number: 1,
					array: [1, 'two'],
				},
				lastname: '',
				firstname: 'Harper',
				array: [1, 2, 'three'],
			},
			{
				one: '',
				object_array: [
					{
						number: 1,
					},
					{
						number: 'two',
						count: 2,
					},
				],
				id: 'c',
				address: '',
				object: '',
				lastname: '',
				firstname: '',
				array: '',
			},
		];
		assert.deepEqual(response.body, expected_res, response.text);
	});

	it('Drop S3 schema', () => {
		return req().send({ operation: 'drop_schema', schema: 'S3_DATA' }).expect(200);
	});

	//Jobs & Job Role Testing Main Folder

	it('Jobs - Add non SU role', () => {
		return req()
			.send({
				operation: 'add_role',
				role: 'developer_test_5',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							customers: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [],
							},
							suppliers: {
								read: false,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [],
							},
							region: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'regiondescription',
										read: true,
										insert: false,
										update: false,
									},
								],
							},
							territories: {
								read: true,
								insert: true,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'territorydescription',
										read: true,
										insert: true,
										update: false,
									},
								],
							},
							categories: {
								read: true,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'description',
										read: true,
										insert: true,
										update: true,
									},
								],
							},
							shippers: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'companyname',
										read: false,
										insert: false,
										update: false,
									},
								],
							},
						},
					},
				},
			})
			.expect(200);
	});

	it('Jobs - Add User with new Role', () => {
		return req()
			.send({
				operation: 'add_user',
				role: 'developer_test_5',
				username: 'test_user',
				password: `${testData.password}`,
				active: true,
			})
			.expect(200);
	});

	it('Jobs - Add jobs test schema', async () => {
		await req()
			.send({ operation: 'create_schema', schema: 'test_job' })
			.expect((r) => assert.ok(r.body.message.includes('successfully created'), r.text))
			.expect(200);
		await setTimeout(500);
	});

	it('Jobs - Add runner table', async () => {
		await req()
			.send({ operation: 'create_table', schema: 'test_job', table: 'runner', hash_attribute: 'runner_id' })
			.expect(200);
		await setTimeout(500);
	});

	it('Jobs - Insert into runners table', async () => {
		await req()
			.send({
				operation: 'insert',
				schema: 'test_job',
				table: 'runner',
				records: [{ name: 'Harper', shoes: 'Nike', runner_id: '1', age: 55 }],
			})
			.expect(200);
		await setTimeout(200);
	});

	it('Jobs - Validate 1 entry in runners table', () => {
		return req()
			.send({ operation: 'sql', sql: 'select * from test_job.runner' })
			.expect((r) => assert.equal(r.body.length, 1, r.text))
			.expect(200);
	});

	it('Jobs - Test Remove Files Before with test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({ operation: 'delete_files_before', date: '2018-06-14', schema: 'dog' })
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0],
					"Operation 'deleteFilesBefore' is restricted to 'super_user' roles",
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
			})
			.expect(403);
	});

	it('Jobs - Test Remove Files Before with su and store job_id', async () => {
		const response = await req()
			.send({
				operation: 'delete_files_before',
				date: `${dateTomorrow}`,
				schema: 'test_job',
				table: 'runner',
			})
			.expect(200);

		const id = await getJobId(response.body);
		const jobResponse = await checkJob(id, 15);
		assert.equal(jobResponse.body[0].message, '1 of 1 record successfully deleted', jobResponse.text);
		testData.job_id = id;
	});

	it('Jobs - Validate 0 entry in runners table', () => {
		return req()
			.send({ operation: 'sql', sql: 'select * from test_job.runner' })
			.expect((r) => assert.equal(r.body.length, 0, r.text))
			.expect(200);
	});

	it('Search Jobs by date', () => {
		return req()
			.send({
				operation: 'search_jobs_by_start_date',
				from_date: `${dateYesterday}`,
				to_date: `${dateTomorrow}`,
			})
			.expect((r) => assert.ok(r.body.length > 0, r.text));
	});

	it('Search Jobs by date - non-super user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_jobs_by_start_date',
				from_date: `${dateYesterday}`,
				to_date: `${dateTomorrow}`,
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0],
					"Operation 'handleGetJobsByStartDate' is restricted to 'super_user' roles",
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
			})
			.expect(403);
	});

	it('Search Jobs by job_id', () => {
		return req()
			.send({ operation: 'get_job', id: `${testData.job_id}` })
			.expect((r) => assert.equal(r.body.length, 1, r.text))
			.expect(200);
	});

	it('Search Jobs by job_id - non-super user', () => {
		return reqAsNonSU(headersTestUser)
			.send({ operation: 'get_job', id: `${testData.job_id}` })
			.expect((r) => assert.equal(r.body.length, 1, r.text))
			.expect(200);
	});

	it('Jobs - Bulk CSV load into restricted region table as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'csv_data_load',
				schema: `${testData.schema}`,
				table: `${testData.regi_tb}`,
				data: "regionid, regiondescription\n'17', 'test description'\n",
			})
			.expect(403);
	});

	it('Jobs - Bulk CSV load into restricted region table as su', () => {
		return req()
			.send({
				operation: 'csv_data_load',
				schema: `${testData.schema}`,
				table: `${testData.regi_tb}`,
				data: "regionid, regiondescription\n'17', 'test description'\n",
			})
			.expect(200);
	});

	it('Jobs - Bulk CSV Load - insert suppliers table restricted attribute as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'csv_file_load',
				action: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.supp_tb}`,
				file_path: `${getCsvPath()}Suppliers.csv`,
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(r.body.invalid_schema_items[0], "Table 'northnwd.suppliers' does not exist", r.text);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('Jobs Test Export To Local using SQL as su', () => {
		return req()
			.send({
				operation: 'export_local',
				path: './',
				filename: 'test_export.json',
				format: 'json',
				search_operation: {
					operation: 'sql',
					sql: `select *
                                    from ${testData.schema}.${testData.ship_tb}`,
				},
			})
			.expect(200);
	});

	it('Jobs Test Export To Local using NoSQL as su', () => {
		return req()
			.send({
				operation: 'export_local',
				path: './',
				filename: 'test_export.json',
				format: 'json',
				search_operation: {
					operation: 'search_by_hash',
					schema: `${testData.schema}`,
					table: `${testData.ship_tb}`,
					hash_attribute: `${testData.ship_id}`,
					hash_values: [1],
					get_attributes: ['companyname'],
				},
			})
			.expect(200);
	});

	it('Jobs Test Export To Local using SQL as test_user on table with FULLY restricted attrs', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'export_local',
				path: './',
				filename: 'test_export.json',
				format: 'json',
				search_operation: {
					operation: 'sql',
					sql: `select *
                                    from ${testData.schema}.${testData.ship_tb}`,
				},
			})
			.expect(200);
	});

	it('Jobs Test Export To Local using SQL on RESTRICTED table as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'export_local',
				path: './',
				filename: 'test_export.json',
				format: 'json',
				search_operation: {
					operation: 'sql',
					sql: `select *
                                    from ${testData.schema}.${testData.supp_tb}`,
				},
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(r.body.invalid_schema_items[0], "Table 'northnwd.suppliers' does not exist", r.text);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('Jobs Test Export To Local using SQL as test_user on table w/ two attr perms', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'export_local',
				path: './',
				filename: 'test_export.json',
				format: 'json',
				search_operation: {
					operation: 'sql',
					sql: `select *
                                    from ${testData.schema}.${testData.regi_tb}`,
				},
			})
			.expect(200);
	});

	it('Jobs Test Export To Local using NoSQL as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'export_local',
				path: './',
				filename: 'test_export',
				format: 'json',
				search_operation: {
					operation: 'search_by_hash',
					schema: `${testData.schema}`,
					table: `${testData.supp_tb}`,
					hash_attribute: `${testData.supp_id}`,
					hash_values: [1],
					get_attributes: [testData.supp_id],
				},
			})
			.expect((r) =>
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				)
			)
			.expect((r) =>
				assert.equal(
					r.body.unauthorized_access[0],
					"Operation 'export_local' is restricted to 'super_user' roles",
					r.text
				)
			)
			.expect(403);
	});

	it('Jobs - drop test user', () => {
		return req().send({ operation: 'drop_user', username: 'test_user' }).expect(200);
	});

	it('Jobs -  drop_role', () => {
		return req().send({ operation: 'drop_role', id: 'developer_test_5' }).expect(200);
	});

	it('Jobs - Delete Jobs_test schema', () => {
		return req()
			.send({ operation: 'drop_schema', schema: 'test_job' })
			.expect((r) => assert.ok(r.body.message.includes('successfully delete'), r.text))
			.expect(200);
	});
});
