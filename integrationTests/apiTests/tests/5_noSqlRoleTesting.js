import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHeaders, testData, getCsvPath, headersBulkLoadUser, headersTestUser } from '../config/envConfig.js';
import { csvDataLoad } from '../utils/csv.js';
import { checkJobCompleted, getJobId } from '../utils/jobs.js';
import { req, reqAsNonSU } from '../utils/request.js';

describe('5. NoSQL Role Testing', () => {
	//NoSQL Role Testing Folder

	//Bulk Load Perms Tests

	it('Add non-SU bulk_load_role', () => {
		return req()
			.send({
				operation: 'add_role',
				role: 'bulk_load_role',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							suppliers: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'companyname',
										read: true,
										insert: true,
										update: true,
									},
								],
							},
							url_csv_data: {
								read: true,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'name',
										read: false,
										insert: true,
										update: false,
									},
									{
										attribute_name: 'section',
										read: true,
										insert: false,
										update: true,
									},
									{ attribute_name: 'image', read: true, insert: true, update: true },
								],
							},
						},
					},
					dev: {
						tables: {
							books: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'books_count',
										read: true,
										insert: false,
										update: true,
									},
								],
							},
							dog: {
								read: true,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'dog_name',
										read: false,
										insert: true,
										update: true,
									},
									{
										attribute_name: 'age',
										read: true,
										insert: false,
										update: true,
									},
									{
										attribute_name: 'adorable',
										read: true,
										insert: true,
										update: false,
									},
									{ attribute_name: 'owner_id', read: true, insert: false, update: false },
								],
							},
							owner: {
								read: true,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'name',
										read: true,
										insert: false,
										update: false,
									},
								],
							},
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.id, r.text))
			.expect(200);
	});

	it('Add user with new bulk_load_role', () => {
		return req()
			.send({
				operation: 'add_user',
				role: 'bulk_load_role',
				username: 'bulk_load_user',
				password: `${testData.password}`,
				active: true,
			})
			.expect(200);
	});

	it('CSV Data Load  update to table w/ new attr & restricted attrs', async () => {
		const errorMsg = await csvDataLoad(
			headersBulkLoadUser,
			'update',
			testData.schema,
			testData.supp_tb,
			'supplierid,companyname, rando\n19,The Chum Bucket, Another attr value\n',
			'This operation is not authorized due to role restrictions and/or invalid database items'
		);
		const resText = JSON.stringify(errorMsg);
		assert.equal(errorMsg.unauthorized_access.length, 0, resText);
		assert.equal(errorMsg.invalid_schema_items.length, 1, resText);
		assert.equal(
			errorMsg.invalid_schema_items[0],
			"Attribute ' rando' does not exist on 'northnwd.suppliers'",
			resText
		);
	});

	it('CSV Data Load - upsert - to table w/ some restricted attrs & new attr', async () => {
		const errorMsg = await csvDataLoad(
			headersBulkLoadUser,
			'upsert',
			testData.schema_dev,
			'dog',
			'id,dog_name,adorable,age,rando\n19,doggy,true,22,Another attr value\n',
			'This operation is not authorized due to role restrictions and/or invalid database items'
		);
		const resText = JSON.stringify(errorMsg);
		assert.equal(errorMsg.unauthorized_access.length, 1, resText);
		const unauth_obj = errorMsg.unauthorized_access[0];
		assert.equal(unauth_obj.schema, 'dev', resText);
		assert.equal(unauth_obj.table, 'dog', resText);
		assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
		assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'adorable', resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'update', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'age', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);
		assert.equal(errorMsg.invalid_schema_items.length, 1, resText);
		assert.equal(errorMsg.invalid_schema_items[0], "Attribute 'rando' does not exist on 'dev.dog'", resText);
	});

	it('CSV URL Load - upsert - to table w/ restricted attrs', async () => {
		const response = await reqAsNonSU(headersBulkLoadUser)
			.send({
				operation: 'csv_url_load',
				action: 'upsert',
				schema: `${testData.schema}`,
				table: `${testData.csv_tb}`,
				csv_url: 'https://harperdb-integration-test-data.s3.us-east-2.amazonaws.com/breeds.csv',
			})
			.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

		const id = await getJobId(response.body);
		const errorMsg = await checkJobCompleted(
			id,
			'This operation is not authorized due to role restrictions and/or invalid database items'
		);

		const resText = JSON.stringify(errorMsg);
		assert.equal(errorMsg.unauthorized_access.length, 1, resText);
		const unauth_obj = errorMsg.unauthorized_access[0];

		assert.equal(unauth_obj.schema, 'northnwd', resText);
		assert.equal(unauth_obj.table, 'url_csv_data', resText);
		assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
		assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'name', resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'update', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'section', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);
		assert.equal(errorMsg.invalid_schema_items.length, 1, resText);
		assert.equal(
			errorMsg.invalid_schema_items[0],
			"Attribute 'country' does not exist on 'northnwd.url_csv_data'",
			resText
		);
	});

	it('CSV URL Load - update - to table w/ restricted attrs', async () => {
		const response = await reqAsNonSU(headersBulkLoadUser)
			.send({
				operation: 'csv_url_load',
				action: 'update',
				schema: `${testData.schema}`,
				table: `${testData.csv_tb}`,
				csv_url: 'https://harperdb-integration-test-data.s3.us-east-2.amazonaws.com/breeds.csv',
			})
			.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

		const id = await getJobId(response.body);
		const errorMsg = await checkJobCompleted(
			id,
			'This operation is not authorized due to role restrictions and/or invalid database items'
		);
		const resText = JSON.stringify(errorMsg);
		assert.equal(errorMsg.unauthorized_access.length, 1, resText);
		const unauth_obj = errorMsg.unauthorized_access[0];

		assert.equal(unauth_obj.schema, 'northnwd', resText);
		assert.equal(unauth_obj.table, 'url_csv_data', resText);
		assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
		assert.equal(unauth_obj.required_attribute_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'name', resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'update', resText);
		assert.equal(errorMsg.invalid_schema_items.length, 1, resText);
		assert.equal(
			errorMsg.invalid_schema_items[0],
			"Attribute 'country' does not exist on 'northnwd.url_csv_data'",
			resText
		);
	});

	it('CSV File Load to table w/ restricted attrs', async () => {
		const response = await reqAsNonSU(headersBulkLoadUser)
			.send({
				operation: 'csv_file_load',
				action: 'insert',
				schema: 'dev',
				table: 'books',
				file_path: `${getCsvPath()}` + 'Books.csv',
			})
			.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text))
			.expect(200);

		const id = await getJobId(response.body);
		const errorMsg = await checkJobCompleted(
			id,
			'This operation is not authorized due to role restrictions and/or invalid database items'
		);
		const resText = JSON.stringify(errorMsg);
		assert.equal(errorMsg.unauthorized_access.length, 1, resText);
		const unauth_obj = errorMsg.unauthorized_access[0];

		assert.equal(unauth_obj.schema, 'dev', resText);
		assert.equal(unauth_obj.table, 'books', resText);
		assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
		assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'id', resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'insert', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'books_count', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);
		assert.equal(errorMsg.invalid_schema_items.length, 17, resText);

		const expected_invalid_items = [
			"Attribute 'authors' does not exist on 'dev.books'",
			"Attribute 'original_publication_year' does not exist on 'dev.books'",
			"Attribute 'original_title' does not exist on 'dev.books'",
			"Attribute 'title' does not exist on 'dev.books'",
			"Attribute 'language_code' does not exist on 'dev.books'",
			"Attribute 'average_rating' does not exist on 'dev.books'",
			"Attribute 'ratings_count' does not exist on 'dev.books'",
			"Attribute 'work_ratings_count' does not exist on 'dev.books'",
			"Attribute 'work_text_reviews_count' does not exist on 'dev.books'",
			"Attribute 'ratings_1' does not exist on 'dev.books'",
			"Attribute 'ratings_2' does not exist on 'dev.books'",
			"Attribute 'ratings_3' does not exist on 'dev.books'",
			"Attribute 'ratings_4' does not exist on 'dev.books'",
			"Attribute 'ratings_5' does not exist on 'dev.books'",
			"Attribute 'nytimes_best_seller' does not exist on 'dev.books'",
			"Attribute 'image_url' does not exist on 'dev.books'",
			"Attribute 'small_image_url' does not exist on 'dev.books'",
		];

		errorMsg.invalid_schema_items.forEach((item) => {
			assert.ok(expected_invalid_items.includes(item), resText);
		});
	});

	it('Import CSV from S3 to table w/ restricted attrs', async () => {
		const response = await reqAsNonSU(headersBulkLoadUser)
			.send({
				operation: 'import_from_s3',
				action: 'insert',
				schema: 'dev',
				table: 'dog',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/dogs.csv',
					region: 'us-east-2',
				},
			})
			.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

		const id = await getJobId(response.body);
		const errorMsg = await checkJobCompleted(
			id,
			'This operation is not authorized due to role restrictions and/or invalid database items'
		);
		const resText = JSON.stringify(errorMsg);
		assert.equal(errorMsg.unauthorized_access.length, 1, resText);
		const unauth_obj = errorMsg.unauthorized_access[0];

		assert.equal(unauth_obj.schema, 'dev', resText);
		assert.equal(unauth_obj.table, 'dog', resText);
		assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
		assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'owner_id', resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'insert', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'age', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);

		assert.equal(errorMsg.invalid_schema_items.length, 2, resText);
		const expected_invalid_items = [
			"Attribute 'breed_id' does not exist on 'dev.dog'",
			"Attribute 'weight_lbs' does not exist on 'dev.dog'",
		];
		errorMsg.invalid_schema_items.forEach((item) => {
			assert.ok(expected_invalid_items.includes(item), resText);
		});
	});

	it('Import JSON from S3 - upsert - to table w/ restricted attrs', async () => {
		const response = await reqAsNonSU(headersBulkLoadUser)
			.send({
				operation: 'import_from_s3',
				action: 'upsert',
				schema: 'dev',
				table: 'owner',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/owners_update.json',
					region: 'us-east-2',
				},
			})
			.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

		const id = await getJobId(response.body);
		const errorMsg = await checkJobCompleted(
			id,
			'This operation is not authorized due to role restrictions and/or invalid database items'
		);
		const resText = JSON.stringify(errorMsg);
		assert.equal(errorMsg.unauthorized_access.length, 1, resText);
		const unauth_obj = errorMsg.unauthorized_access[0];

		assert.equal(unauth_obj.schema, 'dev', resText);
		assert.equal(unauth_obj.table, 'owner', resText);
		assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
		assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'id', resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 2, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'insert', resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[1], 'update', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'name', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 2, resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[1], 'update', resText);
		assert.equal(errorMsg.invalid_schema_items.length, 0, resText);
	});

	it('Import JSON from S3 - insert - to table w/ restricted attrs', async () => {
		const response = await reqAsNonSU(headersBulkLoadUser)
			.send({
				operation: 'import_from_s3',
				action: 'insert',
				schema: 'dev',
				table: 'owner',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/owners_update.json',
					region: 'us-east-2',
				},
			})
			.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

		const id = await getJobId(response.body);
		const errorMsg = await checkJobCompleted(
			id,
			'This operation is not authorized due to role restrictions and/or invalid database items'
		);
		const resText = JSON.stringify(errorMsg);
		assert.equal(errorMsg.unauthorized_access.length, 1, resText);
		const unauth_obj = errorMsg.unauthorized_access[0];

		assert.equal(unauth_obj.schema, 'dev', resText);
		assert.equal(unauth_obj.table, 'owner', resText);
		assert.equal(unauth_obj.required_table_permissions.length, 0, resText);
		assert.equal(unauth_obj.required_attribute_permissions.length, 2, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].attribute_name, 'id', resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[0].required_permissions[0], 'insert', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].attribute_name, 'name', resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions.length, 1, resText);
		assert.equal(unauth_obj.required_attribute_permissions[1].required_permissions[0], 'insert', resText);
		assert.equal(errorMsg.invalid_schema_items.length, 0, resText);
	});

	it('Alter non-SU bulk_load_role', () => {
		return req()
			.send({
				operation: 'alter_role',
				id: 'bulk_load_role',
				role: 'bulk_load_role',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							suppliers: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [],
							},
						},
					},
					dev: {
						tables: {
							dog: {
								read: true,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'dog_name',
										read: false,
										insert: true,
										update: true,
									},
									{
										attribute_name: 'age',
										read: true,
										insert: true,
										update: true,
									},
									{
										attribute_name: 'adorable',
										read: true,
										insert: true,
										update: true,
									},
									{
										attribute_name: 'owner_id',
										read: true,
										insert: true,
										update: true,
									},
									{
										attribute_name: 'weight_lbs',
										read: true,
										insert: true,
										update: true,
									},
									{
										attribute_name: 'breed_id',
										read: true,
										insert: true,
										update: true,
									},
									{ attribute_name: '__updatedtime__', read: true, insert: true, update: false },
								],
							},
						},
					},
				},
			})
			.expect((r) => assert.equal(r.body.id, 'bulk_load_role', r.text))
			.expect(200);
	});

	it('CSV Data Load  upsert to table w/ full perms', () => {
		return csvDataLoad(
			headersBulkLoadUser,
			'upsert',
			testData.schema,
			testData.supp_tb,
			'companyname, new_attr\nThe Chum Bucket, Another attr value\n',
			'',
			'successfully loaded 1 of 1 records'
		);
	});

	it('Check row from Data CSV job was upserted', () => {
		return req()
			.send({
				operation: 'sql',
				sql: `SELECT count(*) AS row_count
                                  FROM ${testData.schema}.${testData.supp_tb}`,
			})
			.expect((r) => assert.equal(r.body[0].row_count, 30, r.text))
			.expect(200);
	});

	it('Import CSV from S3 to table w/ full attr perms - update', async () => {
		const response = await reqAsNonSU(headersBulkLoadUser)
			.send({
				operation: 'import_from_s3',
				action: 'update',
				schema: 'dev',
				table: 'dog',
				s3: {
					aws_access_key_id: `${testData.s3_key}`,
					aws_secret_access_key: `${testData.s3_secret}`,
					bucket: 'harperdb-integration-test-data',
					key: 'non_public_folder/dogs.csv',
					region: 'us-east-2',
				},
			})
			.expect((r) => assert.equal(r.body.message.indexOf('Starting job'), 0, r.text));

		const id = await getJobId(response.body);
		return checkJobCompleted(id, '', 'successfully loaded 9 of 12 records');
	});

	it('Check rows from S3 update were updated', () => {
		return req()
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.dog' })
			.expect((r) => {
				r.body.forEach((row) => {
					assert.ok(row.__updatedtime__ > row.__createdtime__, r.text);
				});
			})
			.expect(200);
	});

	it('Drop bulk_load_user', () => {
		return req()
			.send({ operation: 'drop_user', username: 'bulk_load_user' })
			.expect((r) => assert.ok(r.body.message, r.text))
			.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
			.expect(200);
	});

	it('Drop bulk_load_user role', () => {
		return req()
			.send({ operation: 'drop_role', id: 'bulk_load_role' })
			.expect((r) => assert.ok(r.body.message, r.text))
			.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
			.expect(200);
	});

	//NoSQL Role Testing Main Folder

	it('Authentication - bad username', () => {
		const myHeaders = createHeaders('bad_username', testData.password);
		return reqAsNonSU(myHeaders)
			.send({ operation: 'create_schema', schema: 'auth' })
			.expect((r) => assert.ok(r.text.includes('Login failed')))
			.expect(401);
	});

	it('Authentication - bad password', () => {
		const myHeaders = createHeaders(testData.username, 'bad_password');
		return reqAsNonSU(myHeaders)
			.send({ operation: 'create_schema', schema: 'auth' })
			.expect((r) => assert.ok(r.text.includes('Login failed')))
			.expect(401);
	});

	it('NoSQL Add non SU role', () => {
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
										delete: false,
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
										delete: false,
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
										delete: false,
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
										delete: false,
									},
								],
							},
						},
					},
					dev: {
						tables: {
							dog: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: '__createdtime__',
										read: true,
										insert: true,
										update: true,
									},
									{
										attribute_name: '__updatedtime__',
										read: true,
										insert: true,
										update: true,
									},
									{
										attribute_name: 'age',
										read: true,
										insert: true,
										update: false,
									},
									{
										attribute_name: 'dog_name',
										read: true,
										insert: false,
										update: true,
									},
									{
										attribute_name: 'adorable',
										read: true,
										insert: true,
										update: true,
									},
									{ attribute_name: 'owner_id', read: false, insert: true, update: true },
								],
							},
							breed: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: '__createdtime__',
										read: false,
										insert: false,
										update: true,
									},
									{ attribute_name: '__updatedtime__', read: false, insert: true, update: true },
								],
							},
							dog_conditions: {
								read: true,
								insert: true,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'age',
										read: true,
										insert: false,
										update: false,
									},
									{
										attribute_name: 'group',
										read: true,
										insert: false,
										update: false,
									},
									{
										attribute_name: 'breed_id',
										read: false,
										insert: true,
										update: false,
									},
									{
										attribute_name: 'dog_name',
										read: true,
										insert: false,
										update: false,
									},
									{
										attribute_name: 'id',
										read: true,
										insert: true,
										update: false,
									},
									{ attribute_name: 'location', read: false, insert: false, update: false },
								],
							},
						},
					},
				},
			})
			.expect((r) => assert.equal(r.body.id, 'developer_test_5', r.text))
			.expect(200);
	});

	it('NoSQL Add User with new Role', () => {
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

	it('NoSQL try to get user info as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({ operation: 'list_users' })
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0],
					"Operation 'listUsersExternal' is restricted to 'super_user' roles",
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL Try to read suppliers table as SU', () => {
		return req()
			.send({
				operation: 'search_by_value',
				table: `${testData.supp_tb}`,
				schema: `${testData.schema}`,
				hash_attribute: 'id',
				search_attribute: `${testData.supp_id}`,
				search_value: '*',
				get_attributes: [`${testData.supp_id}`],
			})
			.expect(200);
	});

	it('NoSQL Try to read FULLY restricted suppliers table as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_value',
				table: `${testData.supp_tb}`,
				schema: `${testData.schema}`,
				hash_attribute: 'id',
				search_attribute: `${testData.supp_id}`,
				search_value: '*',
				get_attributes: [`${testData.supp_id}`],
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

	it('NoSQL Try to read region table as SU', () => {
		return req()
			.send({
				operation: 'search_by_value',
				table: `${testData.regi_tb}`,
				schema: `${testData.schema}`,
				hash_attribute: 'id',
				search_attribute: 'regionid',
				search_value: '*',
				get_attributes: ['*'],
			})
			.expect(200);
	});

	it('NoSQL Try to read region table as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_value',
				table: `${testData.regi_tb}`,
				schema: `${testData.schema}`,
				hash_attribute: 'id',
				search_attribute: 'regionid',
				search_value: '*',
				get_attributes: ['*'],
			})
			.expect(200);
	});

	it('NoSQL Try to insert into region table as SU', () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.regi_tb}`,
				records: [{ regionid: 16, regiondescription: 'test description' }],
			})
			.expect(200);
	});

	it('NoSQL Try to insert into insert restricted region table as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.regi_tb}`,
				records: [{ regionid: 17, regiondescription: 'test description' }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'insert', r.text);
				assert.equal(r.body.unauthorized_access[0].schema, 'northnwd', r.text);
				assert.equal(r.body.unauthorized_access[0].table, 'region', r.text);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL Try to insert FULLY restricted attribute in categories table as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.cate_tb}`,
				records: [{ [testData.cate_id]: 9, categoryname: 'test name', description: 'test description' }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'categoryname' does not exist on 'northnwd.categories'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL Try to insert into territories table as SU', () => {
		return req()
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.terr_tb}`,
				records: [{ [testData.terr_id]: 123456, territorydescription: 'test description' }],
			})
			.expect(200);
	});

	it('NoSQL Try to insert into territories table as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.terr_tb}`,
				records: [{ [testData.terr_id]: 1234567, territorydescription: 'test description' }],
			})
			.expect(200);
	});

	it('NoSQL Try to update territories table as SU', () => {
		return req()
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.terr_tb}`,
				records: [{ [testData.terr_id]: 123456, territorydescription: 'test description updated' }],
			})
			.expect(200);
	});

	it('NoSQL Try to update restricted territories table as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.terr_tb}`,
				records: [{ [testData.terr_id]: 1234567, territorydescription: 'test description updated' }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'update', r.text);
				assert.equal(r.body.unauthorized_access[0].schema, 'northnwd', r.text);
				assert.equal(r.body.unauthorized_access[0].table, 'territories', r.text);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL Try to update categories table as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.cate_tb}`,
				records: [{ [testData.cate_id]: 1, description: 'test description updated' }],
			})
			.expect(200);
	});

	it('NoSQL Try to update categories table with new attr as test_user - expect error', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.cate_tb}`,
				records: [{ [testData.cate_id]: 1, description: 'test description updated', active: true }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'active' does not exist on 'northnwd.categories'",
					r.text
				);
			})
			.expect(403);
	});

	it('NoSQL Try to update FULLY restricted attrs in categories table as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.cate_tb}`,
				records: [
					{
						[testData.cate_id]: 1,
						categoryname: 'test name',
						description: 'test description updated',
						picture: 'test picture',
					},
				],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 2, r.text);
				assert.ok(
					r.body.invalid_schema_items.includes("Attribute 'categoryname' does not exist on 'northnwd.categories'"),
					r.text
				);
				assert.ok(
					r.body.invalid_schema_items.includes("Attribute 'picture' does not exist on 'northnwd.categories'"),
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL Try to delete from categories table as SU', () => {
		return req()
			.send({ operation: 'delete', table: `${testData.cate_tb}`, schema: `${testData.schema}`, hash_values: [1] })
			.expect(200);
	});

	it('NoSQL Try to delete from restricted categories table as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({ operation: 'delete', table: `${testData.cate_tb}`, schema: `${testData.schema}`, hash_values: [2] })
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'delete', r.text);
				assert.equal(r.body.unauthorized_access[0].schema, 'northnwd', r.text);
				assert.equal(r.body.unauthorized_access[0].table, 'categories', r.text);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL Try to read shippers table FULLY restricted attribute as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_value',
				table: `${testData.ship_tb}`,
				schema: `${testData.schema}`,
				hash_attribute: 'id',
				search_attribute: `${testData.ship_id}`,
				search_value: '*',
				get_attributes: ['companyname'],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 2, r.text);
				assert.ok(
					r.body.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'"),
					r.text
				);
				assert.ok(
					r.body.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'"),
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL Try to read ALL shippers table FULLY restricted attributes as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_value',
				table: `${testData.ship_tb}`,
				schema: `${testData.schema}`,
				hash_attribute: 'id',
				search_attribute: `${testData.ship_id}`,
				search_value: '*',
				get_attributes: ['*'],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'shipperid' does not exist on 'northnwd.shippers'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL Try to update shippers table FULLY restricted attributes as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.ship_tb}`,
				records: [{ [testData.ship_id]: 1, companyname: 'bad update name' }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 2, r.text);
				assert.ok(
					r.body.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'"),
					r.text
				);
				assert.ok(
					r.body.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'"),
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL Try to insert shippers table restricted attributes as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.ship_tb}`,
				records: [{ [testData.ship_id]: 1, companyname: 'bad update name', phone: '(503) 555-9831' }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 3, r.text);
				assert.ok(
					r.body.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'"),
					r.text
				);
				assert.ok(
					r.body.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'"),
					r.text
				);
				assert.ok(
					r.body.invalid_schema_items.includes("Attribute 'phone' does not exist on 'northnwd.shippers'"),
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL Try to insert to categories table with FULLY restricted attribute as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.cate_tb}`,
				records: [{ [testData.cate_id]: 4, categoryname: 'bad update name' }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'categoryname' does not exist on 'northnwd.categories'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL Try to insert categories table unrestricted attribute as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.cate_tb}`,
				records: [{ [testData.cate_id]: 1, description: 'Cheese and cheese and cheese' }],
			})
			.expect(200);
	});

	it('NoSQL Try to update categories table unrestricted attribute as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'update',
				schema: `${testData.schema}`,
				table: `${testData.cate_tb}`,
				records: [{ [testData.cate_id]: 2, description: 'Meats and cheeses' }],
			})
			.expect(200);
	});

	it('NoSQL Try to insert to categories table FULLY restricted attribute as test_user', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'insert',
				schema: `${testData.schema}`,
				table: `${testData.cate_tb}`,
				records: [{ [testData.cate_id]: 1, categoryname: 'Stuff and things' }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'categoryname' does not exist on 'northnwd.categories'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL create_schema - non-SU expect fail', () => {
		return reqAsNonSU(headersTestUser)
			.send({ operation: 'create_schema', schema: 'test-schema' })
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0],
					"Operation 'createSchema' is restricted to 'super_user' roles",
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL create_schema - SU expect success', () => {
		return req().send({ operation: 'create_schema', schema: 'test-schema' }).expect(200);
	});

	it('NoSQL create_table - non-SU expect fail', () => {
		return reqAsNonSU(headersTestUser)
			.send({ operation: 'create_table', schema: 'test-schema', table: 'test-table', hash_attribute: 'id' })
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0],
					"Operation 'createTable' is restricted to 'super_user' roles",
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL create_table - SU expect success', () => {
		return req()
			.send({ operation: 'create_table', schema: 'test-schema', table: 'test-table', hash_attribute: 'id' })
			.expect(200);
	});

	it('Insert record to evaluate dropAttribute', () => {
		return req()
			.send({
				operation: 'insert',
				schema: 'test-schema',
				table: 'test-table',
				records: [{ id: 1, test_attribute: 'Stuff and things' }],
			})
			.expect(200);
	});

	it('NoSQL drop_attribute - non-SU expect fail', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'drop_attribute',
				schema: 'test-schema',
				table: 'test-table',
				attribute: 'test_attribute',
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
					"Operation 'dropAttribute' is restricted to 'super_user' roles",
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL drop_attribute - SU expect success', () => {
		return req()
			.send({
				operation: 'drop_attribute',
				schema: 'test-schema',
				table: 'test-table',
				attribute: 'test_attribute',
			})
			.expect(200);
	});

	it('NoSQL drop_table - non-SU expect fail', () => {
		return reqAsNonSU(headersTestUser)
			.send({ operation: 'drop_table', schema: 'test-schema', table: 'test-table' })
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0],
					"Operation 'dropTable' is restricted to 'super_user' roles",
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL drop_table - SU expect success', () => {
		return req().send({ operation: 'drop_table', schema: 'test-schema', table: 'test-table' }).expect(200);
	});

	it('NoSQL drop_schema - non-SU expect fail', () => {
		return reqAsNonSU(headersTestUser)
			.send({ operation: 'drop_schema', schema: 'test-schema' })
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0],
					"Operation 'dropSchema' is restricted to 'super_user' roles",
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL drop_schema - SU expect success', () => {
		return req().send({ operation: 'drop_schema', schema: 'test-schema' }).expect(200);
	});

	it('NoSQL Try to update timestamp value on dog table as test_user - expect fail', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'insert',
				schema: 'dev',
				table: 'dog',
				records: [
					{ id: 1, __createdtime__: 'Stuff and things' },
					{
						id: 2,
						__updatedtime__: 'Stuff and other things',
					},
				],
			})
			.expect((r) =>
				assert.equal(
					r.body.error,
					"Internal timestamp attributes - '__createdtime_' and '__updatedtime__' - cannot be inserted to or updated by HDB users."
				)
			)
			.expect(403);
	});

	it('NoSQL Try to update attr w/ timestamp value in update row as SU  - expect success', () => {
		return req()
			.send({
				operation: 'update',
				schema: 'dev',
				table: 'dog',
				records: [
					{ id: 1, adorable: false, __createdtime__: 'Stuff and things' },
					{
						id: 2,
						adorable: false,
						__updatedtime__: 'Stuff and other things',
					},
				],
			})
			.expect((r) => assert.equal(r.body.message, 'updated 2 of 2 records', r.text))
			.expect((r) => assert.equal(r.body.update_hashes.length, 2, r.text))
			.expect(200);
	});

	it('NoSQL Try to update timestamp value on dog table as SU - expect', () => {
		return req()
			.send({
				operation: 'update',
				schema: 'dev',
				table: 'dog',
				records: [
					{ id: 1, __createdtime__: 'Stuff and things' },
					{
						id: 2,
						__updatedtime__: 'Stuff and other things',
					},
				],
			})
			.expect((r) => assert.equal(r.body.message, 'updated 2 of 2 records', r.text))
			.expect((r) => assert.equal(r.body.update_hashes.length, 2, r.text))
			.expect(200);
	});

	it('NoSQL - Upsert - table perms true/no attribute perms set - expect success', () => {
		return req()
			.send({
				operation: 'upsert',
				schema: `${testData.schema}`,
				table: `${testData.cust_tb}`,
				records: [
					{
						[testData.cust_id]: 'FURIB',
						region: 'Durkastan',
						contactmame: 'Hans Blix',
					},
					{ region: 'Durkastan', contactmame: 'Hans Blix' },
				],
			})
			.expect((r) => {
				assert.equal(r.body.upserted_hashes.length, 2, r.text);
				assert.ok(r.body.upserted_hashes.includes('FURIB'), r.text);
				assert.ok(!r.body.skipped_hashes, r.text);
				assert.equal(r.body.message, 'upserted 2 of 2 records', r.text);
			})
			.expect(200);
	});

	it('NoSQL - Upsert - table perms true/attr perms true - expect success', () => {
		return req()
			.send({
				operation: 'upsert',
				schema: `${testData.schema}`,
				table: `${testData.cate_tb}`,
				records: [{ [testData.cate_id]: 8, description: 'Seaweed and fishies' }, { description: 'Junk food' }],
			})
			.expect((r) => {
				assert.equal(r.body.upserted_hashes.length, 2, r.text);
				assert.ok(r.body.upserted_hashes.includes(8), r.text);
				assert.ok(!r.body.skipped_hashes, r.text);
				assert.equal(r.body.message, 'upserted 2 of 2 records', r.text);
			})
			.expect(200);
	});

	it('NoSQL - Upsert - table perms true/no attr perms and new attribute included - expect success', () => {
		return req()
			.send({
				operation: 'upsert',
				schema: `${testData.schema}`,
				table: `${testData.cust_tb}`,
				records: [
					{
						[testData.cust_id]: 'FURIB',
						region: 'Durkastan',
						contactmame: 'Hans Blix',
						active: false,
					},
					{ region: 'Durkastan', contactmame: 'Sam Johnson', active: true },
				],
			})
			.expect((r) => {
				assert.equal(r.body.upserted_hashes.length, 2, r.text);
				assert.ok(r.body.upserted_hashes.includes('FURIB'), r.text);
				assert.ok(!r.body.skipped_hashes, r.text);
				assert.equal(r.body.message, 'upserted 2 of 2 records', r.text);
			})
			.expect(200);
	});

	it('NoSQL - Upsert - table perms true/false  - expect error', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'upsert',
				schema: `${testData.schema}`,
				table: `${testData.terr_tb}`,
				records: [
					{ regionid: 1, territorydescription: 'Westboro', territoryid: 1581 },
					{
						regionid: 55,
						territorydescription: 'Denver Metro',
					},
				],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].schema, 'northnwd', r.text);
				assert.equal(r.body.unauthorized_access[0].table, 'territories', r.text);
				assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].required_table_permissions[0], 'update', r.text);
				assert.equal(r.body.unauthorized_access[0].required_attribute_permissions.length, 0, r.text);
			})
			.expect(403);
	});

	it('NoSQL - Upsert - table perms true/attr perms true but new attribute included - expect error', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'upsert',
				schema: `${testData.schema}`,
				table: `${testData.cate_tb}`,
				records: [
					{
						[testData.cate_id]: 8,
						description: 'Seaweed and fishies',
						active: true,
					},
					{ description: 'Junk food', active: false },
				],
			})
			.expect((r) => {
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'active' does not exist on 'northnwd.categories'",
					r.text
				);
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
			})
			.expect(403);
	});

	it('NoSQL - Upsert - table perms true/some attr perms false - expect error', () => {
		const expected_attr_perm_errs = {
			dog_name: 'insert',
			age: 'update',
		};

		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'upsert',
				schema: 'dev',
				table: 'dog',
				records: [
					{ adorable: true, dog_name: 'Penny', owner_id: 2, age: 5, id: 10 },
					{
						adorable: true,
						dog_name: 'Penny',
						owner_id: 2,
						age: 5,
						id: 2,
					},
					{ adorable: true, dog_name: 'Penny', owner_id: 2, age: 5, id: 10, birthday: '10/11/19' },
				],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].schema, 'dev', r.text);
				assert.equal(r.body.unauthorized_access[0].table, 'dog', r.text);
				assert.equal(r.body.unauthorized_access[0].required_table_permissions.length, 0, r.text);
				assert.equal(r.body.unauthorized_access[0].required_attribute_permissions.length, 2, r.text);
				r.body.unauthorized_access[0].required_attribute_permissions.forEach((attr_perm_err) => {
					assert.equal(
						attr_perm_err.required_permissions[0],
						expected_attr_perm_errs[attr_perm_err.attribute_name],
						r.text
					);
				});
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(r.body.invalid_schema_items[0], "Attribute 'birthday' does not exist on 'dev.dog'", r.text);
			})
			.expect(403);
	});

	it('NoSQL - Upsert - w/ null value as hash- expect error', () => {
		return req()
			.send({
				operation: 'upsert',
				schema: `${testData.schema}`,
				table: `${testData.cust_tb}`,
				records: [
					{
						[testData.cust_id]: 'null',
						region: 'Durkastan',
						contactmame: 'Hans Blix',
						active: false,
					},
					{ region: 'Durkastan', contactmame: 'Sam Johnson', active: true },
				],
			})
			.expect((r) =>
				assert.equal(
					r.body.error,
					"Invalid hash value: 'null' is not a valid hash attribute value, check log for more info"
				)
			)
			.expect(400);
	});

	it('NoSQL - Upsert - w/ invalid attr name - expect error', () => {
		return req()
			.send({
				operation: 'upsert',
				schema: `${testData.schema}`,
				table: `${testData.cust_tb}`,
				records: [
					{
						[testData.cust_id]: 'FURIB',
						'region': 'Durkastan',
						'contactmame': 'Hans Blix',
						'active/not active': false,
					},
					{ 'region': 'Durkastan', 'contactmame': 'Sam Johnson', 'active/not active': false },
				],
			})
			.expect((r) => assert.equal(r.body.error, 'Attribute names cannot include backticks or forward slashes', r.text))
			.expect(400);
	});

	it('search by conditions - equals - allowed attr', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'age', search_type: 'equals', search_value: 5 }],
			})
			.expect((r) => {
				assert.equal(r.body.length, 2, r.text);
				r.body.forEach((row) => {
					assert.ok([1, 2].includes(row.id), r.text);
					assert.ok(!row.location, r.text);
					assert.ok(!row.breed_id, r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - ends_with - allowed attr', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'dog_name', search_type: 'ends_with', search_value: 'y' }],
			})
			.expect((r) => {
				assert.equal(r.body.length, 4, r.text);
				r.body.forEach((row) => {
					assert.equal([...row.dog_name].pop(), 'y', r.text);
					assert.ok(!row.location, r.text);
					assert.ok(!row.breed_id, r.text);
				});
			})
			.expect(200);
	});

	it('search by conditions - equals - restricted attr', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'location', search_type: 'equals', search_value: 'Denver, CO' }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'location' does not exist on 'dev.dog_conditions'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('search by conditions - contains - restricted attr', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'location', search_type: 'contains', search_value: 'Denver' }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'location' does not exist on 'dev.dog_conditions'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('search by conditions - starts_with - non-existent attr', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'random_attr', search_type: 'starts_with', search_value: 1 }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'random_attr' does not exist on 'dev.dog_conditions'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it("search by conditions - starts_with - unauth'd attr", () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [{ search_attribute: 'breed_id', search_type: 'starts_with', search_value: 1 }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 0, r.text);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].schema, 'dev', r.text);
				assert.equal(r.body.unauthorized_access[0].table, 'dog_conditions', r.text);
				assert.equal(r.body.unauthorized_access[0].required_attribute_permissions.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0].required_attribute_permissions[0].attribute_name,
					'breed_id',
					r.text
				);
				assert.equal(
					r.body.unauthorized_access[0].required_attribute_permissions[0].required_permissions[0],
					'read',
					r.text
				);
			})
			.expect(403);
	});

	it("search by conditions - starts_with - unauth'd attrs in get / search", () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['id', 'dog_name', 'location'],
				conditions: [{ search_attribute: 'breed_id', search_type: 'starts_with', search_value: 1 }],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'location' does not exist on 'dev.dog_conditions'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].schema, 'dev', r.text);
				assert.equal(r.body.unauthorized_access[0].table, 'dog_conditions', r.text);
				assert.equal(r.body.unauthorized_access[0].required_attribute_permissions.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0].required_attribute_permissions[0].attribute_name,
					'breed_id',
					r.text
				);
				assert.equal(
					r.body.unauthorized_access[0].required_attribute_permissions[0].required_permissions[0],
					'read',
					r.text
				);
			})
			.expect(403);
	});

	it('search by conditions - equals & contains - restricted attr', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [
					{
						search_attribute: 'group',
						search_type: 'equals',
						search_value: 'A',
					},
					{ search_attribute: 'location', search_type: 'contains', search_value: 'CO' },
				],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'location' does not exist on 'dev.dog_conditions'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('search by conditions - starts_with & between w/ sort', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				sort_attributes: [
					{ attribute: 'age', desc: false },
					{ attribute: 'location', desc: true },
				],
				conditions: [
					{
						search_attribute: 'group',
						search_type: 'between',
						search_value: ['A', 'C'],
					},
					{ search_attribute: 'location', search_type: 'starts_with', search_value: 'Denver' },
				],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 1, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'location' does not exist on 'dev.dog_conditions'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it('search by conditions - 4 conditions - restricted attrs', () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [
					{
						search_attribute: 'group_id',
						search_type: 'between',
						search_value: [0, 100],
					},
					{
						search_attribute: 'dog_name',
						search_type: 'ends_with',
						search_value: 'y',
					},
					{
						search_attribute: 'location',
						search_type: 'contains',
						search_value: 'enve',
					},
					{ search_attribute: 'age', search_type: 'greater_than', search_value: 1 },
				],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 2, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'group_id' does not exist on 'dev.dog_conditions'",
					r.text
				);
				assert.equal(
					r.body.invalid_schema_items[1],
					"Attribute 'location' does not exist on 'dev.dog_conditions'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 0, r.text);
			})
			.expect(403);
	});

	it("search by conditions - 4 conditions - restricted/unauth'd attrs", () => {
		return reqAsNonSU(headersTestUser)
			.send({
				operation: 'search_by_conditions',
				schema: 'dev',
				table: 'dog_conditions',
				get_attributes: ['*'],
				conditions: [
					{
						search_attribute: 'group_id',
						search_type: 'between',
						search_value: [0, 100],
					},
					{ search_attribute: 'breed_id', search_type: 'equals', search_value: 5 },
					{
						search_attribute: 'age',
						search_type: 'less_than',
						search_value: 100,
					},
					{ search_attribute: 'location', search_type: 'contains', search_value: 'enver,' },
				],
			})
			.expect((r) => {
				assert.equal(
					r.body.error,
					'This operation is not authorized due to role restrictions and/or invalid database items',
					r.text
				);
				assert.equal(r.body.invalid_schema_items.length, 2, r.text);
				assert.equal(
					r.body.invalid_schema_items[0],
					"Attribute 'group_id' does not exist on 'dev.dog_conditions'",
					r.text
				);
				assert.equal(
					r.body.invalid_schema_items[1],
					"Attribute 'location' does not exist on 'dev.dog_conditions'",
					r.text
				);
				assert.equal(r.body.unauthorized_access.length, 1, r.text);
				assert.equal(r.body.unauthorized_access[0].schema, 'dev', r.text);
				assert.equal(r.body.unauthorized_access[0].table, 'dog_conditions', r.text);
				assert.equal(r.body.unauthorized_access[0].required_attribute_permissions.length, 1, r.text);
				assert.equal(
					r.body.unauthorized_access[0].required_attribute_permissions[0].attribute_name,
					'breed_id',
					r.text
				);
				assert.equal(
					r.body.unauthorized_access[0].required_attribute_permissions[0].required_permissions[0],
					'read',
					r.text
				);
			})
			.expect(403);
	});

	it('NoSQL Alter non-SU role', () => {
		return req()
			.send({
				operation: 'alter_role',
				id: 'developer_test_5',
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
										delete: false,
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
										delete: false,
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
										delete: false,
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
										delete: false,
									},
								],
							},
						},
					},
					dev: {
						tables: {
							dog: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: '__createdtime__',
										read: true,
										insert: true,
										update: true,
									},
									{ attribute_name: '__updatedtime__', read: true, insert: true, update: true },
								],
							},
							breed: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: '__createdtime__',
										read: false,
										insert: false,
										update: true,
									},
									{ attribute_name: '__updatedtime__', read: false, insert: true, update: true },
								],
							},
						},
					},
				},
			})
			.expect(200);
	});

	it('NoSQL drop test user', () => {
		return req().send({ operation: 'drop_user', username: 'test_user' }).expect(200);
	});

	it('NoSQL drop_role', () => {
		return req().send({ operation: 'drop_role', id: 'developer_test_5' }).expect(200);
	});

	it('NoSQL Add cluster_user Role', () => {
		return req()
			.send({ operation: 'add_role', role: 'test_cluster_user_role', permission: { cluster_user: true } })
			.expect((r) => {
				assert.ok(r.body.id, r.text);
				testData.cluster_user_role_id = r.body.id;
			});
	});

	it('NoSQL Add cluster_user with another permission, expect fail', () => {
		return req()
			.send({
				operation: 'add_role',
				role: 'cluster_user_bad',
				permission: { cluster_user: true, super_user: true },
			})
			.expect((r) => {
				assert.equal(r.body.error, 'Errors in the role permissions JSON provided', r.text);
				assert.equal(r.body.main_permissions.length, 1, r.text);
				assert.equal(
					r.body.main_permissions[0],
					"Roles cannot have both 'super_user' and 'cluster_user' values included in their permissions set.",
					r.text
				);
				assert.equal(Object.keys(r.body.schema_permissions).length, 0, r.text);
			})
			.expect(400);
	});

	it('NoSQL Add User with cluster_user Role', () => {
		return req()
			.send({
				operation: 'add_user',
				role: 'test_cluster_user_role',
				username: 'test_cluster_user',
				password: `${testData.password}`,
				active: true,
			})
			.expect((r) => assert.ok(r.body.message, r.text))
			.expect((r) => assert.ok(r.body.message.includes('successfully added'), r.text))
			.expect(200);
	});

	it('NoSQL alter cluster user, change password', () => {
		return req()
			.send({ operation: 'alter_user', username: 'test_cluster_user', password: `${testData.password}111` })
			.expect((r) => assert.ok(r.body.message, r.text))
			.expect((r) => assert.ok(r.body.message.includes('updated 1 of 1 records'), r.text))
			.expect(200);
	});

	it('NoSQL drop test_cluster_user', () => {
		return req()
			.send({ operation: 'drop_user', username: 'test_cluster_user' })
			.expect((r) => assert.ok(r.body.message, r.text))
			.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
			.expect(200);
	});

	it('NoSQL drop cluster_user role', () => {
		return req()
			.send({ operation: 'drop_role', id: `${testData.cluster_user_role_id}` })
			.expect((r) => assert.ok(r.body.message, r.text))
			.expect((r) => assert.ok(r.body.message.includes('successfully deleted'), r.text))
			.expect(200);
	});
});
