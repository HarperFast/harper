import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import {
	createHeaders,
	envUrl,
	generic,
	headers, headersImportantUser,
	headersNoPermsUser,
	headersOnePermUser,
	headersTestUser,
} from '../config/envConfig.js';

describe('10. Other Role Tests', () => {


	//Other Role Tests Folder

	//Describe ops role testing
		//super_user tests

	it('Describe schema - SU on system schema', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'describe_schema', schema: 'system' })
			.expect((r) => {
				assert.ok(Object.keys(r.body).length > 0);
				assert.ok(r.body.hdb_info.schema == 'system');
			})
			.expect(200);
	});

	it('Describe Schema - schema doesnt exist', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'describe_schema', schema: 'blahh' })
			.expect((r) => assert.ok(r.body.error == "database 'blahh' does not exist"))
			.expect(404);
	});

	it('Describe Table - SU on system table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'describe_table', schema: 'system', table: 'hdb_user' })
			.expect((r) => {
				assert.ok(Object.keys(r.body).length > 0);
				assert.ok(r.body.schema == 'system');
				assert.ok(r.body.name == 'hdb_user');
			})
			.expect(200);
	});

	it('Describe Table - schema and table don t exist', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'describe_table', schema: 'blahh', table: 'blahh' })
			.expect((r) => assert.ok(r.body.error == "database 'blahh' does not exist"))
			.expect(404);
	});

	it('Describe Table - table doesnt exist', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'describe_table', schema: 'dev', table: 'blahh' })
			.expect((r) => assert.ok(r.body.error == "Table 'dev.blahh' does not exist"))
			.expect(404);
	});

	//Describe ops role testing
		//[NOMINAL] Non-SU test_user

	it('Add non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'test_dev_role',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							region: {
								read: true,
								insert: true,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'regiondescription',
										read: true,
										insert: true,
										update: false,
									},
								],
							},
							territories: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [],
							},
							categories: {
								read: false,
								insert: false,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'description',
										read: false,
										insert: false,
										update: false,
										delete: true,
									},
								],
							},
							products: {
								read: false,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'discontinued',
										read: false,
										insert: false,
										update: false,
									},
								],
							},
						},
					},
					other: {
						tables: {
							owner: {
								read: true,
								insert: false,
								update: true,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'name',
										read: false,
										insert: false,
										update: true,
									},
								],
							},
						},
					},
					another: {
						tables: {
							breed: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'name',
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

	it('Add User with non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'test_dev_role',
				username: 'test_user',
				password: `${generic.password}`,
				active: true,
			})
			.expect(200);
	});

	it('Describe All - non-SU test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'describe_all' })
			.expect((r) => {
				const keys = Object.keys(r.body);
				assert.ok(keys.length == 3);
				assert.ok(r.body.hasOwnProperty('another'));
				assert.ok(r.body.another.hasOwnProperty('breed'));
				assert.ok(r.body.another.breed.schema == 'another');
				assert.ok(r.body.another.breed.name == 'breed');
				assert.ok(r.body.another.breed.attributes.length == 0);
				assert.ok(r.body.another.breed.hash_attribute == 'id');
				assert.ok(r.body.another.breed.record_count == 350);
				assert.ok(r.body.another.breed.hasOwnProperty('clustering_stream_name'));
				assert.ok(r.body.another.breed.hasOwnProperty('last_updated_record'));
				assert.ok(r.body.hasOwnProperty('northnwd'));
				assert.ok(r.body.northnwd.hasOwnProperty('categories'));
				assert.ok(r.body.northnwd.hasOwnProperty('region'));
				assert.ok(r.body.northnwd.hasOwnProperty('territories'));
				assert.ok(Object.keys(r.body.northnwd).length == 3);
				assert.ok(Object.keys(r.body.other).length == 1);
				assert.ok(r.body.other.hasOwnProperty('owner'));
			})
			.expect(200);
	});

	it('Describe Schema - restricted perms - non-SU test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'describe_schema', schema: 'dev' })
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "database 'dev' does not exist"))
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('Describe Schema - non-SU test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'describe_schema', schema: 'northnwd' })
			.expect((r) => {
				assert.ok(Object.values(r.body).length == 3);
				assert.ok(r.body.hasOwnProperty('categories'));
				assert.ok(r.body.hasOwnProperty('region'));
				assert.ok(r.body.hasOwnProperty('territories'));
			})
			.expect(200);
	});

	it('Describe Table - restricted perms - non-SU test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'describe_table', schema: 'northnwd', table: 'shippers' })
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'northnwd.shippers' does not exist"))
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('Describe Table - non-SU test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'describe_table', schema: 'northnwd', table: 'region' })
			.expect((r) => assert.ok(r.body.hasOwnProperty('schema')))
			.expect((r) => assert.ok(r.body.hasOwnProperty('name')))
			.expect((r) => assert.ok(r.body.hasOwnProperty('attributes')))
			.expect((r) => assert.ok(r.body.hasOwnProperty('hash_attribute')))
			.expect((r) => assert.ok(r.body.hasOwnProperty('clustering_stream_name')))
			.expect((r) => assert.ok(r.body.hasOwnProperty('record_count')))
			.expect((r) => assert.ok(r.body.hasOwnProperty('last_updated_record')))
			.expect((r) => assert.ok(r.body.attributes.length == 2))
			.expect(200);
	});

	it('Describe  SYSTEM schema as non-SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'describe_table', schema: 'system' })
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
			.expect((r) =>
				assert.ok(
					r.body.unauthorized_access[0] == "Your role does not have permission to view database metadata for 'system'"
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
			.expect(403);
	});

	it('Describe  SYSTEM table as non-SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'describe_table', table: 'hdb_user', schema: 'system' })
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
			.expect((r) =>
				assert.ok(
					r.body.unauthorized_access[0] == "Your role does not have permission to view database metadata for 'system'"
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
			.expect(403);
	});

	it('List Users does not return protected info', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'list_users' })
			.expect((r) => {
				r.body.forEach((user) => {
					assert.ok(!user.password);
					assert.ok(!user.hash);
					assert.ok(!user.refresh_token);
				});
			})
			.expect(200);
	});

	it('Drop test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_user', username: 'test_user' })
			.expect((r) => assert.ok(r.body.message == 'test_user successfully deleted'))
			.expect(200);
	});

	it('Drop_role - non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: 'test_dev_role' })
			.expect((r) => assert.ok(r.body.message == 'test_dev_role successfully deleted'))
			.expect(200);
	});


	//Describe ops role testing
		//Non-SU role w/ NO PERMS

	it('Add non-SU role with NO PERMS', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'add_role', role: 'developer_test_no_perms', permission: { super_user: false } })
			.expect(200);
	});

	it('Add User with new NO PERMS Role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'developer_test_no_perms',
				username: 'no_perms_user',
				password: `${generic.password}`,
				active: true,
			})
			.expect(200);
	});

	it('Describe All - test user NO PERMS', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersNoPermsUser)
			.send({ operation: 'describe_all' })
			.expect((r) => assert.deepEqual(r.body, {}))
			.expect(200);
	});

	it('Describe Schema - test user NO PERMS', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersNoPermsUser)
			.send({ operation: 'describe_schema', schema: 'northnwd' })
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "database 'northnwd' does not exist"))
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('Describe Table - test user NO PERMS', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersNoPermsUser)
			.send({ operation: 'describe_table', schema: 'northnwd', table: 'region' })
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'northnwd.region' does not exist"))
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('Drop no_perms_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_user', username: 'no_perms_user' })
			.expect((r) => assert.ok(r.body.message == 'no_perms_user successfully deleted'))
			.expect(200);
	});

	it('Drop_role - NO PERMS role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: 'developer_test_no_perms' })
			.expect((r) => assert.ok(r.body.message == 'developer_test_no_perms successfully deleted'))
			.expect(200);
	});

	//Describe ops role testing
		//Non-SU role w/ ONE TABLE PERM

	it('Add non-SU role with perm for ONE table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test_one_perm',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							employees: {
								read: true,
								insert: true,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'city',
										read: false,
										insert: true,
										update: false,
									},
									{
										attribute_name: 'firstname',
										read: true,
										insert: true,
										update: false,
									},
									{
										attribute_name: 'lastname',
										read: true,
										insert: true,
										update: false,
									},
									{
										attribute_name: 'region',
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

	it('Add User with new ONE PERM Role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'developer_test_one_perm',
				username: 'one_perm_user',
				password: `${generic.password}`,
				active: true,
			})
			.expect(200);
	});

	it('Describe All - test user ONE TABLE PERM', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersOnePermUser)
			.send({ operation: 'describe_all' })
			.expect((r) => {
				assert.ok(Object.keys(r.body).length == 1);
				assert.ok(Object.keys(r.body.northnwd).length == 1);
				assert.ok(Object.keys(r.body.northnwd.employees).length > 11);
				assert.ok(typeof r.body.northnwd.employees.db_size == 'number');
				assert.ok(typeof r.body.northnwd.employees.table_size == 'number');
				assert.ok(r.body.northnwd.employees.attributes.length == 4);
			})
			.expect(200);
	});

	it('Describe Schema - restricted schema - non-SU test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersOnePermUser)
			.send({ operation: 'describe_schema', schema: 'dev' })
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "database 'dev' does not exist"))
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('Describe Schema - non-SU test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersOnePermUser)
			.send({ operation: 'describe_schema', schema: 'northnwd' })
			.expect((r) => {
				let expected_schema = {
					northnwd: {
						employees: ['employeeid', 'city', 'firstname', 'lastname'],
					},
				};

				let response_arr = Object.values(r.body);
				assert.ok(response_arr.length == 1);

				response_arr.forEach((table_data) => {
					const { name, schema, attributes } = table_data;
					attributes.forEach((attr) => {
						assert.ok(expected_schema[schema][name].includes(attr.attribute));
					});
				});
			})
			.expect(200);
	});

	it('Describe Table - restricted table - non-SU test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersOnePermUser)
			.send({ operation: 'describe_table', schema: 'northnwd', table: 'shippers' })
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'northnwd.shippers' does not exist"))
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('Describe Table - non-SU test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersOnePermUser)
			.send({ operation: 'describe_table', schema: 'northnwd', table: 'employees' })
			.expect((r) => {
				let top_attributes = [
					'name',
					'schema',
					'id',
					'hash_attribute',
					'__updatedtime__',
					'__createdtime__',
					'attributes',
					'record_count',
				];
				let expected_attributes = ['employeeid', 'city', 'firstname', 'lastname'];

				assert.ok(r.body.schema == 'northnwd');
				assert.ok(r.body.name == 'employees');
				r.body.attributes.forEach((attr) => {
					assert.ok(expected_attributes.includes(attr.attribute));
				});
				assert.ok(r.body.attributes.length == 4);
			})
			.expect(200);
	});

	it('Drop one_perm_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_user', username: 'one_perm_user' })
			.expect((r) => assert.ok(r.body.message == 'one_perm_user successfully deleted'))
			.expect(200);
	});

	it('Drop_role - ONE TABLE PERMS role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: 'developer_test_one_perm' })
			.expect((r) => assert.ok(r.body.message == 'developer_test_one_perm successfully deleted'))
			.expect(200);
	});


	//Add Role - error checks

	it('Add role with mismatched table/attr READ perms - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							categories: {
								read: false,
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
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 0))
			.expect((r) =>
				assert.ok(
					r.body.schema_permissions.northnwd_categories[0] ==
						"You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true"
				)
			)
			.expect(400);
	});

	it('Add role with non-boolean READ table perms - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							categories: {
								read: 'Doooooh',
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
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 0))
			.expect((r) => assert.ok(r.body.schema_permissions.northnwd_categories.length == 1))
			.expect((r) =>
				assert.ok(r.body.schema_permissions.northnwd_categories[0] == 'Table READ permission must be a boolean')
			)
			.expect(400);
	});

	it('Add role with non-boolean INSERT/DELETE perms - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							categories: {
								read: true,
								insert: 'Doooooh',
								update: true,
								delete: 'Doooooh',
								attribute_permissions: [
									{
										attribute_name: 'description',
										read: true,
										insert: true,
										update: true,
									},
								],
							},
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 0))
			.expect((r) => assert.ok(r.body.schema_permissions.northnwd_categories.length == 2))
			.expect((r) =>
				assert.ok(r.body.schema_permissions.northnwd_categories.includes('Table INSERT permission must be a boolean'))
			)
			.expect((r) =>
				assert.ok(r.body.schema_permissions.northnwd_categories.includes('Table DELETE permission must be a boolean'))
			)
			.expect(400);
	});

	it('Add role with non-boolean READ and UPDATE attribute perms - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							categories: {
								read: true,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'description',
										read: 'Doooooh',
										insert: true,
										update: 'Doooooh',
									},
								],
							},
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 0))
			.expect((r) => assert.ok(r.body.schema_permissions.northnwd_categories.length == 2))
			.expect((r) =>
				assert.ok(
					r.body.schema_permissions.northnwd_categories.includes(
						"READ attribute permission for 'description' must be a boolean"
					)
				)
			)
			.expect((r) =>
				assert.ok(
					r.body.schema_permissions.northnwd_categories.includes(
						"UPDATE attribute permission for 'description' must be a boolean"
					)
				)
			)
			.expect(400);
	});

	it('Add role with mismatched table/attr INSERT perms - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							categories: {
								read: true,
								insert: false,
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
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 0))
			.expect((r) =>
				assert.ok(
					r.body.schema_permissions.northnwd_categories[0] ==
						"You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true"
				)
			)
			.expect(400);
	});

	it('Add role with mismatched table/attr UPDATE perms - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							categories: {
								read: true,
								insert: true,
								update: false,
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
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 0))
			.expect((r) =>
				assert.ok(
					r.body.schema_permissions.northnwd_categories[0] ==
						"You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true"
				)
			)
			.expect(400);
	});

	it('Add role with multiple mismatched table/attr perms - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							categories: {
								read: false,
								insert: true,
								update: false,
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
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 0))
			.expect((r) =>
				assert.ok(
					r.body.schema_permissions.northnwd_categories[0] ==
						"You have a conflict with TABLE permissions for 'northnwd.categories' being false and ATTRIBUTE permissions being true"
				)
			)
			.expect(400);
	});

	it('Add role with with misformed attr perms array key  - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							categories: {
								read: false,
								insert: true,
								update: false,
								delete: false,
								attribute_restrictions: [
									{
										attribute_name: 'description',
										read: true,
										insert: true,
										update: true,
									},
								],
							},
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 0))
			.expect((r) =>
				assert.ok(
					r.body.schema_permissions.northnwd_categories.includes(
						"Invalid table permission key value 'attribute_restrictions'"
					)
				)
			)
			.expect((r) =>
				assert.ok(r.body.schema_permissions.northnwd_categories.includes("Missing 'attribute_permissions' array"))
			)
			.expect(400);
	});

	it('Add role with with missing attr perms for table  - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							categories: {
								read: false,
								insert: true,
								update: false,
								delete: false,
							},
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 0))
			.expect((r) =>
				assert.ok(r.body.schema_permissions.northnwd_categories[0] == "Missing 'attribute_permissions' array")
			)
			.expect(400);
	});

	it('Add role with with perms for non-existent schema  - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: false,
					wrong_schema: {
						tables: {
							categories: {
								read: false,
								insert: true,
								update: false,
								delete: false,
							},
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 1))
			.expect((r) => assert.ok(r.body.main_permissions[0] == "database 'wrong_schema' does not exist"))
			.expect((r) => assert.ok(Object.keys(r.body.schema_permissions).length == 0))
			.expect(400);
	});

	it('Add role with with perms for non-existent table  - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							wrong_table: {
								read: false,
								insert: true,
								update: false,
								delete: false,
							},
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 1))
			.expect((r) => assert.ok(r.body.main_permissions[0] == "Table 'northnwd.wrong_table' does not exist"))
			.expect((r) => assert.ok(Object.keys(r.body.schema_permissions).length == 0))
			.expect(400);
	});

	it('Add SU role with perms  - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					super_user: true,
					northnwd: {
						tables: {
							categories: {
								read: false,
								insert: true,
								update: false,
								delete: false,
								attribute_permissions: [],
							},
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 1))
			.expect((r) =>
				assert.ok(
					r.body.main_permissions[0] == "Roles with 'super_user' set to true cannot have other permissions set."
				)
			)
			.expect((r) => assert.ok(Object.keys(r.body.schema_permissions).length == 0))
			.expect(400);
	});

	it('Add CU role with perms  - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'developer_test',
				permission: {
					cluster_user: true,
					northnwd: {
						tables: {
							categories: {
								read: false,
								insert: true,
								update: false,
								delete: false,
								attribute_permissions: [],
							},
						},
					},
				},
			})
			.expect((r) => assert.ok(r.body.error == 'Errors in the role permissions JSON provided'))
			.expect((r) => assert.ok(r.body.main_permissions.length == 1))
			.expect((r) =>
				assert.ok(
					r.body.main_permissions[0] == "Roles with 'cluster_user' set to true cannot have other permissions set."
				)
			)
			.expect((r) => assert.ok(Object.keys(r.body.schema_permissions).length == 0))
			.expect(400);
	});


	//Test SU-only Ops Permissions

	it('Add non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'test_dev_role',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							region: {
								read: true,
								insert: true,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'regiondescription',
										read: true,
										insert: true,
										update: false,
									},
								],
							},
							territories: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [],
							},
							categories: {
								read: false,
								insert: false,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'description',
										read: false,
										insert: false,
										update: false,
										delete: true,
									},
								],
							},
							products: {
								read: false,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'discontinued',
										read: false,
										insert: false,
										update: false,
									},
								],
							},
						},
					},
					other: {
						tables: {
							owner: {
								read: true,
								insert: false,
								update: true,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'name',
										read: false,
										insert: false,
										update: true,
									},
								],
							},
						},
					},
					another: {
						tables: {
							breed: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'name',
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

	it('Add User with non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'test_dev_role',
				username: 'test_user',
				password: `${generic.password}`,
				active: true,
			})
			.expect(200);
	});

	it('system_information as non-SU - expect fail', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'system_information' })
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
			.expect((r) =>
				assert.ok(r.body.unauthorized_access[0] == "Operation 'systemInformation' is restricted to 'super_user' roles")
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
			.expect(403);
	});

	it('Drop test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_user', username: 'test_user' })
			.expect((r) => assert.ok(r.body.message == 'test_user successfully deleted'))
			.expect(200);
	});

	it('Drop_role - non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: 'test_dev_role' })
			.expect((r) => assert.ok(r.body.message == 'test_dev_role successfully deleted'))
			.expect(200);
	});


	//System schema role perms tests

	it('Add non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'test_dev_role',
				permission: {
					super_user: false,
					northnwd: {
						tables: {
							region: {
								read: true,
								insert: true,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'regiondescription',
										read: true,
										insert: true,
										update: false,
									},
								],
							},
							territories: {
								read: true,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [],
							},
							categories: {
								read: false,
								insert: false,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'description',
										read: false,
										insert: false,
										update: false,
										delete: true,
									},
								],
							},
							products: {
								read: false,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'discontinued',
										read: false,
										insert: false,
										update: false,
									},
								],
							},
						},
					},
					other: {
						tables: {
							owner: {
								read: true,
								insert: false,
								update: true,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'name',
										read: false,
										insert: false,
										update: true,
									},
								],
							},
						},
					},
					another: {
						tables: {
							breed: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'name',
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

	it('Add User with non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'test_dev_role',
				username: 'test_user',
				password: `${generic.password}`,
				active: true,
			})
			.expect(200);
	});

	it('Query system table as SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'search_by_value',
				table: 'hdb_user',
				schema: 'system',
				search_attribute: 'username',
				search_value: `${generic.username}`,
				get_attributes: ['*'],
			})
			.expect((r) => {
				let objKeysData = Object.keys(r.body[0]);
				assert.ok(r.body[0].username == generic.username);
				assert.ok(objKeysData.includes('password'));
				assert.ok(objKeysData.includes('role'));
			})
			.expect(200);
	});

	it('Query system table non SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'search_by_value',
				table: 'hdb_user',
				schema: 'system',
				search_attribute: 'username',
				search_value: `${generic.username}`,
				get_attributes: ['*'],
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions[0] == 'read'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'system'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'hdb_user'))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
			.expect(403);
	});

	it('Insert record system table as non SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'insert',
				schema: 'system',
				table: 'hdb_user',
				records: [
					{
						username: 'admin',
						role: '0bffc136-0b0b-4582-8efe-44031f40d906',
						password: 'fakepassword',
						active: true,
					},
				],
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions[0] == 'insert'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'system'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'hdb_user'))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
			.expect(403);
	});

	it('Update record system table as non SU ', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'update',
				schema: 'system',
				table: 'hdb_user',
				records: [
					{
						username: 'admin',
						role: '0bffc136-0b0b-4582-8efe-44031f40d906',
						password: 'fakepassword',
						active: true,
					},
				],
			})
			.expect((r) =>
				assert.ok(
					r.body.error ==
						"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."
				)
			)
			.expect(403);
	});

	it('Delete record system table as non SU ', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'delete', schema: 'system', table: 'hdb_user', hash_values: ['admin1'] })
			.expect((r) =>
				assert.ok(
					r.body.error ==
						"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."
				)
			)
			.expect(403);
	});

	it('Drop system table as SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_table', schema: 'system', table: 'hdb_user' })
			.expect((r) =>
				assert.ok(
					r.body.error ==
						"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."
				)
			)
			.expect(403);
	});

	it('Drop system table as non SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'drop_table', schema: 'system', table: 'hdb_user' })
			.expect((r) =>
				assert.ok(
					r.body.error ==
						"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."
				)
			)
			.expect(403);
	});

	it('Drop test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_user', username: 'test_user' })
			.expect((r) => assert.ok(r.body.message == 'test_user successfully deleted'))
			.expect(200);
	});

	it('Drop_role - non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: 'test_dev_role' })
			.expect((r) => assert.ok(r.body.message == 'test_dev_role successfully deleted'))
			.expect(200);
	});

	it('SQL update system table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: "UPDATE system.hdb_user SET name = 'jerry' where id = 1" })
			.expect((r) =>
				assert.ok(
					r.body.error ==
						"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."
				)
			)
			.expect(403);
	});

	it('SQL delete system table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'delete from system.hdb_user where id = 1' })
			.expect((r) =>
				assert.ok(
					r.body.error ==
						"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."
				)
			)
			.expect(403);
	});

	it('Delete attribute from system table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_attribute', schema: 'system', table: 'hdb_user', attribute: 'password' })
			.expect((r) =>
				assert.ok(
					r.body.error ==
						"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."
				)
			)
			.expect(403);
	});


	//Search schema error checks

	it('Add non-SU role for schema tests', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'test_schema_user',
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
						},
					},
				},
			})
			.expect(200);
	});

	it('Add test_user  with new role for schema error tests', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'test_schema_user',
				username: 'test_user',
				password: `${generic.password}`,
				active: true,
			})
			.expect(200);
	});

	it('NoSQL - Non-SU search on schema that doesnt exist as test_user - expect error', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'search_by_value',
				schema: 'rick_rolled',
				table: `${generic.regi_tb}`,
				hash_attribute: 'id',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['*'],
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "database 'rick_rolled' does not exist"))
			.expect(403);
	});

	it('NoSQL - SU search on schema that doesnt exist as test_user - expect error', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'search_by_value',
				schema: 'rick_rolled',
				table: `${generic.regi_tb}`,
				hash_attribute: 'id',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['*'],
			})
			.expect((r) => assert.ok(r.body.error == "database 'rick_rolled' does not exist"))
			.expect(404);
	});

	it('NoSQL - Non-SU search on table that doesnt exist as test_user - expect error', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'rick_rolled',
				hash_attribute: 'id',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['*'],
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'dev.rick_rolled' does not exist"))
			.expect(403);
	});

	it('NoSQL - SU search on table that doesnt exist as error', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'search_by_value',
				schema: 'dev',
				table: 'rick_rolled',
				hash_attribute: 'id',
				search_attribute: 'id',
				search_value: '*',
				get_attributes: ['*'],
			})
			.expect((r) => assert.ok(r.body.error == "Table 'dev.rick_rolled' does not exist"))
			.expect(404);
	});

	it('SQL - Non-SU select on schema that doesnt exist as test_user - expect error', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: `SELECT *
                                  FROM rick_rolled.${generic.regi_tb}`,
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "database 'rick_rolled' does not exist"))
			.expect(403);
	});

	it('SQL - SU search on schema that doesnt exist as error', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `SELECT *
                                  FROM rick_rolled.${generic.regi_tb}`,
			})
			.expect((r) => assert.ok(r.body.error == "database 'rick_rolled' does not exist"))
			.expect(404);
	});

	it('SQL - Non-SU search on table that doesnt exist as test_user - expect error', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.rick_rolled' })
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'dev.rick_rolled' does not exist"))
			.expect(403);
	});

	it('SQL - SU search on table that doesnt exist as test_user - expect error', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'SELECT * FROM dev.rick_rolled' })
			.expect((r) => assert.ok(r.body.error == "Table 'dev.rick_rolled' does not exist"))
			.expect(404);
	});

	it('Drop test_user for search schema error checks', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_user', username: 'test_user' })
			.expect(200);
	});

	it('Drop role for search schema error checks', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: 'test_schema_user' })
			.expect(200);
	});


	//Test modifying system tables

	it('Insert record into table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				database: 'system',
				table: 'hdb_nodes',
				records: [{ name: 'my-node', url: 'lets-test' }],
			})
			.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'))
			.expect((r) => assert.ok(r.body.inserted_hashes[0] == 'my-node'))
			.expect(200);
	});

	it('Update record into table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'update',
				database: 'system',
				table: 'hdb_nodes',
				records: [{ name: 'my-node', url: 'updated-url' }],
			})
			.expect((r) =>
				assert.ok(
					r.body.message == 'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.ok(r.body.update_hashes[0] == 'my-node'))
			.expect(200);
	});

	it('Confirm record in table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'search_by_id',
				database: 'system',
				table: 'hdb_nodes',
				ids: ['my-node'],
				get_attributes: ['*'],
			})
			.expect((r) => assert.ok(r.body[0].name == 'my-node'))
			.expect((r) => assert.ok(r.body[0].url == 'updated-url'))
			.expect(200);
	});

	it('Confirm table cant be dropped', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_table', database: 'system', table: 'hdb_nodes' })
			.expect((r) =>
				assert.ok(
					r.body.error ==
						"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."
				)
			)
			.expect(403);
	});

	it('Insert record into hdb cert doesnt work', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'insert',
				database: 'system',
				table: 'hdb_certificate',
				records: [{ name: 'my-node', url: 'lets-test' }],
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect(403);
	});


	//Other Role Tests Main Folder

	it('Add non-SU role to test with', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'add_role', role: 'important-role', permission: { structure_user: true } })
			.expect(200);
	});

	it('Create user with new role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'important-role',
				username: 'important-user',
				password: 'password',
				active: true,
			})
			.expect(200);
	});

	it('Update role table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'update',
				database: 'system',
				table: 'hdb_role',
				records: [{ id: 'important-role', test: true }],
			})
			.expect((r) =>
				assert.ok(
					r.body.message == 'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.ok(r.body.update_hashes[0] == 'important-role'))
			.expect(200);
	});

	it('Update user table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'update',
				database: 'system',
				table: 'hdb_user',
				records: [{ username: 'important-user', test: true }],
			})
			.expect((r) =>
				assert.ok(
					r.body.message == 'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.ok(r.body.update_hashes[0] == 'important-user'))
			.expect(200);
	});

	it('Test Update role table non-SU doesnt work', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersImportantUser)
			.send({
				operation: 'update',
				database: 'system',
				table: 'hdb_role',
				records: [{ id: 'important-role', test: true }],
			})
			.expect((r) =>
				assert.ok(
					r.body.error ==
						"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."
				)
			)
			.expect(403);
	});

	it('Test Update user table non-SU doesnt work', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersImportantUser)
			.send({
				operation: 'update',
				database: 'system',
				table: 'hdb_user',
				records: [{ username: 'important-user', test: true }],
			})
			.expect((r) =>
				assert.ok(
					r.body.error ==
						"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."
				)
			)
			.expect(403);
	});

	it('Test insert when non-SU doesnt work', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersImportantUser)
			.send({
				operation: 'insert',
				database: 'system',
				table: 'hdb_nodes',
				records: [{ name: 'my-node', url: 'no-go' }],
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect(403);
	});

	it('Test delete when non-SU doesnt work', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersImportantUser)
			.send({ operation: 'delete', database: 'system', table: 'hdb_nodes', ids: ['my-node'] })
			.expect((r) =>
				assert.ok(
					r.body.error ==
						"The 'system' database, tables and records are used internally by HarperDB and cannot be updated or removed."
				)
			)
			.expect(403);
	});

	it('Delete record from table', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'delete', database: 'system', table: 'hdb_nodes', ids: ['my-node'] })
			.expect((r) => assert.ok(r.body.message == '1 of 1 record successfully deleted'))
			.expect((r) => assert.ok(r.body.deleted_hashes[0] == 'my-node'))
			.expect(200);
	});

	it('Drop user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_user', username: 'important-user' })
			.expect((r) => assert.ok(r.body.message == 'important-user successfully deleted'))
			.expect(200);
	});

	it('Drop role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: 'important-role' })
			.expect((r) => assert.ok(r.body.message == 'important-role successfully deleted'))
			.expect(200);
	});

	it('Add non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_role',
				role: 'test_dev_role',
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

	it('Add non-SU role w/ same name', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'add_role', role: 'test_dev_role', permission: { super_user: false } })
			.expect((r) => assert.ok(r.body.error == "A role with name 'test_dev_role' already exists"))
			.expect(409);
	});

	it('Query HDB as bad user', async () => {
		const myHeaders = createHeaders('JohnnyBadUser', generic.password);
		const response = await request(envUrl)
			.post('')
			.set(myHeaders)
			.send({
				operation: 'search_by_value',
				table: 'hdb_user',
				schema: 'system',
				search_attribute: 'username',
				search_value: `${generic.username}`,
				get_attributes: ['*'],
			})
			.expect((r) => assert.ok(r.text.includes('Login failed')))
			.expect(401);
	});

	it('alter_role with bad data', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'alter_role',
				role: 'bad_user_2',
				id: 'test_dev_role',
				permission: {
					super_user: false,
					crapschema: {
						tables: {
							blahblah: {
								read: false,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'name',
										read: false,
										insert: false,
										update: true,
									},
								],
							},
						},
					},
					dev: {
						tables: {
							craptable: {
								read: false,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'name',
										read: false,
										insert: false,
										update: true,
									},
								],
							},
							dog: {
								read: false,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'name',
										read: false,
										insert: false,
										update: true,
									},
									{ attribute_name: 'crapattribute', read: false, insert: false, update: true },
								],
							},
						},
					},
				},
			})
			.expect((r) => {
				assert.ok(r.body.main_permissions.length == 2);
				assert.ok(r.body.main_permissions.includes("database 'crapschema' does not exist"));
				assert.ok(r.body.main_permissions.includes("Table 'dev.craptable' does not exist"));

				assert.ok(r.body.schema_permissions.dev_dog.length == 2);
				assert.ok(r.body.schema_permissions.dev_dog.includes("Invalid attribute 'name' in 'attribute_permissions'"));
				assert.ok(
					r.body.schema_permissions.dev_dog.includes("Invalid attribute 'crapattribute' in 'attribute_permissions'")
				);
			})
			.expect(400);
	});

	it('list_roles ensure role not changed', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'list_roles' })
			.expect((r) => {
				let found_role = undefined;
				for (let role of r.body) {
					if (role.role === 'bad_user_2') {
						found_role = role;
					}
				}
				assert.ok(found_role == undefined);
			})
			.expect(200);
	});

	it('alter_role good data', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'alter_role',
				role: 'user_role_update',
				id: 'test_dev_role',
				permission: {
					super_user: false,
					[generic.schema]: {
						tables: {
							[generic.cust_tb]: {
								read: false,
								insert: false,
								update: false,
								delete: false,
								attribute_permissions: [
									{
										attribute_name: 'fax',
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
			.expect((r) => {
				assert.ok(r.body.role == 'user_role_update');
				assert.ok(r.body.id == 'test_dev_role');
				assert.ok(r.body.permission.super_user == false);
				assert.deepEqual(r.body.permission.northnwd.tables.customers, {
					read: false,
					insert: false,
					update: false,
					delete: false,
					attribute_permissions: [
						{
							attribute_name: 'fax',
							read: false,
							insert: false,
							update: false,
						},
					],
				});
			})
			.expect(200);
	});

	it('list_roles ensure role was updated', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'list_roles' })
			.expect((r) => {
				let found_role = undefined;
				for (let role of r.body) {
					if (role.role === 'user_role_update') {
						found_role = role;
					}
				}
				assert.ok(found_role.role == 'user_role_update');
			})
			.expect(200);
	});

	it('Drop_role nonexistent role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: '12345' })
			.expect((r) => assert.ok(r.body.error == 'Role not found'))
			.expect(404);
	});

	it('Drop_role for non-SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: 'test_dev_role' })
			.expect(200);
	});
});
