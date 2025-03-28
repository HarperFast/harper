import { describe, it } from 'node:test';
import assert from 'node:assert';
import request from 'supertest';
import { envUrl, generic, headers, headersTestUser } from '../config/envConfig.js';

describe('6. SQL Role Testing', () => {


	//SQL Role Testing Folder

	it('SQL Add non SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
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
					dev: {
						tables: {
							dog: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [],
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
										update: false,
									},
								],
							},
						},
					},
					another: {
						tables: {
							breed: {
								read: false,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [
									{
										attribute_name: 'image',
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

	it('SQL Add User with new Role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'developer_test_5',
				username: 'test_user',
				password: `${generic.password}`,
				active: true,
			})
			.expect((r) => assert.ok(r.body.message == 'test_user successfully added'))
			.expect(200);
	});

	it('Add user that already exists', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'developer_test_5',
				username: 'test_user',
				password: `${generic.password}`,
				active: true,
			})
			.expect((r) => assert.ok(r.body.error == 'User test_user already exists'))
			.expect(409);
	});

	it('Add user bad role name', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'add_user',
				role: 'developer_test 5',
				username: 'test_user1',
				password: `${generic.password}`,
				active: true,
			})
			.expect((r) => assert.ok(r.body.error == 'Role is invalid'))
			.expect(400);
	});

	it('get user info', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'list_users' })
			.expect((r) => {
				for (let user of r.body) {
					if (user.username === 'test_user') {
						assert.ok(generic.cluster_user_role_id == user.role.id);
					}
				}
			})
			.expect(200);
	});

	it('try to set bad role to user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'alter_user', role: 'blahblah', username: 'test_user' })
			.expect((r) => assert.ok(r.body.error == "Update failed.  Requested 'blahblah' role not found."))
			.expect(404);
	});

	it('get user info make sure role was not changed', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'list_users' })
			.expect((r) => {
				for (let user of r.body) {
					if (user.username === 'test_user') {
						assert.ok(generic.cluster_user_role_id == user.role.id);
					}
				}
			})
			.expect(200);
	});

	it('SQL Try to read suppliers table as SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
                                  from ${generic.schema}.${generic.supp_tb}`,
			})
			.expect(200);
	});

	it('SQL Try to read FULLY restricted suppliers table as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: `select *
                                  from ${generic.schema}.${generic.supp_tb}`,
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) => assert.ok(r.body.invalid_schema_items[0] == "Table 'northnwd.suppliers' does not exist"))
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('SQL Try to read region table as SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: `select *
                                  from ${generic.schema}.${generic.regi_tb}`,
			})
			.expect(200);
	});

	it('SQL Try to read region table as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: `select *
                                  from ${generic.schema}.${generic.regi_tb}`,
			})
			.expect((r) => {
				let permitted_attrs = ['regiondescription', 'regionid', '__createdtime__', '__updatedtime__'];
				r.body.forEach((obj) => {
					Object.keys(obj).forEach((attr_name) => {
						console.log(attr_name);
						assert.ok(permitted_attrs.includes(attr_name));
					});
				});
			})
			.expect(200);
	});

	it('SQL Try to insert into region table as SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "insert into northnwd.region (regionid, regiondescription) values ('16', 'test description')",
			})
			.expect(200);
	});

	it('SQL Try to insert into restricted region table as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: "insert into northnwd.region (regionid, regiondescription) values ('17', 'test description')",
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions[0] == 'insert'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'northnwd'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'region'))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
			.expect(403);
	});

	it('SQL Try to insert into territories table as SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "insert into northnwd.territories (regionid, territoryid, territorydescription) values ('1', '65', 'Im a test')",
			})
			.expect(200);
	});

	it('SQL Try to insert into territories table with restricted attribute as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: "insert into northnwd.territories (regionid, territoryid, territorydescription) values ('1', '65', 'Im a test')",
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items[0] == "Attribute 'regionid' does not exist on 'northnwd.territories'")
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('SQL Try to insert into territories table with allowed attributes as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: "insert into northnwd.territories (territoryid, territorydescription) values (165, 'Im a test')",
			})
			.expect((r) => assert.ok(r.body.message == 'inserted 1 of 1 records'))
			.expect((r) => assert.ok(r.body.inserted_hashes[0] == 165))
			.expect(200);
	});

	it('SQL Try to update territories table as SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'sql',
				sql: "update northnwd.territories set territorydescription = 'update test' where territoryid = 65",
			})
			.expect(200);
	});

	it('SQL Try to update restricted territories table as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: "update northnwd.territories set territorydescription = 'update test' where territoryid = 65",
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions[0] == 'update'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'northnwd'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'territories'))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
			.expect(403);
	});

	it('SQL Try to update categories table as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: "update northnwd.categories set description = 'update test' where categoryid = 2",
			})
			.expect(200);
	});

	it('SQL Try to update restricted attr in categories table as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: "update northnwd.categories set description = 'update test', picture = 'test picture' where categoryid = 2",
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items[0] == "Attribute 'picture' does not exist on 'northnwd.categories'")
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('SQL Try to delete from categories table as SU', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'sql', sql: 'delete from northnwd.categories where categoryid = 2' })
			.expect(200);
	});

	it('SQL Try to delete from restricted categories table as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({ operation: 'sql', sql: 'delete from northnwd.categories where categoryid = 2' })
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions[0] == 'delete'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'northnwd'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'categories'))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 0))
			.expect(403);
	});

	it('SQL Try to read shippers table w/ FULLY restricted attributes as test_user - expect empty array', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: `select *
                                  from ${generic.schema}.${generic.ship_tb}`,
			})
			.expect((r) => assert.ok(r.body.length == 0))
			.expect(200);
	});

	it('SQL Try to update shippers table restricted attribute as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: `update ${generic.schema}.${generic.ship_tb}
              set companyname = 'bad update name'
              where ${generic.ship_id} = 1`,
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 1))
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items[0] == "Attribute 'companyname' does not exist on 'northnwd.shippers'")
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('SQL Try to insert into shippers table w/ FULLY restricted attributes as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: "insert into northnwd.shippers (shipperid, companyname, phone) values ('1', 'bad update name', '(503) 555-9831')",
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 3))
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'"))
			)
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'"))
			)
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'phone' does not exist on 'northnwd.shippers'"))
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('SQL Try to insert categories table unrestricted attributes as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: "insert into northnwd.categories (categoryid, description) values ('9', 'Other food stuff')",
			})
			.expect(200);
	});

	it('SQL Try to read shippers table as test_user with restricted attribute in WHERE', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: `select shipperid
              from ${generic.schema}.${generic.ship_tb}
              WHERE (phone IS NOT NULL AND shipperid = 0)
                 OR companyname IS NOT NULL`,
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 3))
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'shipperid' does not exist on 'northnwd.shippers'"))
			)
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'phone' does not exist on 'northnwd.shippers'"))
			)
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'companyname' does not exist on 'northnwd.shippers'"))
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('Select with restricted CROSS SCHEMA JOIN as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id',
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
			.expect((r) => assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")))
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"))
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('Select * with restricted CROSS SCHEMA JOIN as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: 'SELECT d.*, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1',
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
			.expect((r) => assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")))
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"))
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('Select restricted attrs in CROSS 3 SCHEMA JOINS as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name, b.id, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id',
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions[0] == 'read'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'another'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'breed'))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
			.expect((r) => assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")))
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"))
			)
			.expect(403);
	});

	it('Select with complex CROSS 3 SCHEMA JOINS as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: 'SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name, b.image FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name',
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions[0] == 'read'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'another'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'breed'))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
			.expect((r) => assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")))
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"))
			)
			.expect(403);
	});

	it('Select * w/ two table CROSS SCHEMA JOIN on table with FULLY restricted attributes as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: 'SELECT d.*, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1',
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 2))
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"))
			)
			.expect((r) => assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")))
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 0))
			.expect(403);
	});

	it('SQL ALTER non SU role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'alter_role',
				role: 'developer_test_5',
				id: 'developer_test_5',
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
					dev: {
						tables: {
							dog: {
								read: true,
								insert: true,
								update: true,
								delete: true,
								attribute_permissions: [],
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
										read: true,
										insert: false,
										update: false,
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
			.expect(200);
	});

	it('Select two table CROSS SCHEMA JOIN as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id',
			})
			.expect((r) => {
				assert.ok(r.body.length == 9);
				const expected_attributes = ['id', 'dog_name', 'age', 'adorable', 'id1', 'name'];
				//Important to test that only the id (returned as id1) and name attributes come back for 'other.owner'
				// since user only has access to those two attributes
				r.body.forEach((row) => {
					expected_attributes.forEach((attr) => {
						assert.ok(row[attr]);
					});
				});
			})
			.expect((r) => assert.ok(r.body[1].name == 'Kyle'))
			.expect((r) => assert.ok(r.body[3].id1 == 1))
			.expect((r) => assert.ok(r.body[4].id1 == 2))
			.expect(200);
	});

	it('Select * w/ two table CROSS SCHEMA JOIN as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: 'SELECT d.*, o.* FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id ORDER BY o.name, o.id LIMIT 5 OFFSET 1',
			})
			.expect((r) => assert.ok(r.body.length == 5))
			.expect((r) => {
				let expected_names = ['David', 'Kaylan', 'Kyle', 'Kyle', 'Kyle'];
				let expected_attrs = [
					'__createdtime__',
					'age',
					'dog_name',
					'adorable',
					'owner_id',
					'__updatedtime__',
					'id',
					'weight_lbs',
					'breed_id',
					'name',
					'id1',
				];
				r.body.forEach((obj, i) => {
					assert.ok(obj.name == expected_names[i]);
					let keys = Object.keys(obj);
					keys.forEach((key) => {
						assert.ok(expected_attrs.includes(key));
					});
				});
			})
			.expect(200);
	});

	it('Select w/ CROSS 3 SCHEMA JOINS as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: 'SELECT d.id, d.dog_name, d.age, d.adorable, o.id, o.name, b.id, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id',
			})
			.expect((r) => {
				assert.ok(r.body.length == 9);
				r.body.forEach((row) => {
					assert.ok(row.id);
					assert.ok(row.id1);
					assert.ok(row.id2);
					assert.ok(row.dog_name);
					assert.ok(row.age);
					assert.ok(row.name);
					assert.ok(row.name1);
				});
			})
			.expect((r) => assert.ok(r.body[1].name == 'Kyle'))
			.expect((r) => assert.ok(r.body[1].id1 == 2))
			.expect((r) => assert.ok(r.body[4].id1 == 2))
			.expect((r) => assert.ok(r.body[6].id1 == 4))
			.expect((r) => assert.ok(r.body[6].name1 == 'BEAGLE MIX'))
			.expect(200);
	});

	it('Select with complex CROSS 3 SCHEMA JOINS as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: 'SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name',
			})
			.expect((r) => {
				assert.ok(r.body.length == 9);
				r.body.forEach((row) => {
					assert.ok(row.dog_age);
					assert.ok(row.dog_weight);
					assert.ok(row.owner_name);
					assert.ok(row.name);
				});
			})
			.expect((r) => assert.ok(r.body[0].dog_age == 3))
			.expect((r) => assert.ok(r.body[0].dog_weight == 35))
			.expect((r) => assert.ok(r.body[0].owner_name == 'Kaylan'))
			.expect((r) => assert.ok(r.body[0].name == 'BEAGLE MIX'))
			.expect((r) => assert.ok(r.body[6].dog_age == 8))
			.expect((r) => assert.ok(r.body[6].dog_weight == 15))
			.expect((r) => assert.ok(r.body[6].owner_name == 'Kyle'))
			.expect((r) => assert.ok(r.body[6].name == 'TERRIER MIX'))
			.expect(200);
	});

	it('SQL ALTER non SU role with multi table join restrictions', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({
				operation: 'alter_role',
				role: 'developer_test_5',
				id: 'developer_test_5',
				permission: {
					super_user: false,
					dev: {
						tables: {
							dog: {
								read: false,
								insert: true,
								update: true,
								delete: false,
								attribute_permissions: [],
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
										update: false,
									},
								],
							},
						},
					},
					another: {
						tables: {
							breed: {
								read: true,
								insert: false,
								update: false,
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
			.expect(200);
	});

	it('Select with ALL RESTRICTED complex CROSS 3 SCHEMA JOINS as test_user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headersTestUser)
			.send({
				operation: 'sql',
				sql: 'SELECT d.age AS dog_age, AVG(d.weight_lbs) AS dog_weight, o.name AS owner_name, b.name, b.country FROM dev.dog AS d INNER JOIN other.owner AS o ON d.owner_id = o.id INNER JOIN another.breed AS b ON d.breed_id = b.id GROUP BY o.name, b.name, d.age ORDER BY b.name',
			})
			.expect((r) =>
				assert.ok(
					r.body.error == 'This operation is not authorized due to role restrictions and/or invalid database items'
				)
			)
			.expect((r) => assert.ok(r.body.unauthorized_access.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions.length == 1))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].required_table_permissions[0] == 'read'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].schema == 'dev'))
			.expect((r) => assert.ok(r.body.unauthorized_access[0].table == 'dog'))
			.expect((r) => assert.ok(r.body.invalid_schema_items.length == 3))
			.expect((r) => assert.ok(r.body.invalid_schema_items.includes("Attribute 'id' does not exist on 'other.owner'")))
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'name' does not exist on 'other.owner'"))
			)
			.expect((r) =>
				assert.ok(r.body.invalid_schema_items.includes("Attribute 'country' does not exist on 'another.breed'"))
			)
			.expect(403);
	});

	it('SQL drop test user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_user', username: 'test_user' })
			.expect((r) => assert.ok(r.body.message == 'test_user successfully deleted'))
			.expect(200);
	});

	it('Drop non-existent user', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_user', username: 'test_user' })
			.expect((r) => assert.ok(r.body.error == 'User test_user does not exist'))
			.expect(404);
	});

	it('SQL drop_role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: 'developer_test_5' })
			.expect((r) => assert.ok(r.body.message == 'developer_test_5 successfully deleted'))
			.expect(200);
	});

	it('Drop non-existent role', async () => {
		const response = await request(envUrl)
			.post('')
			.set(headers)
			.send({ operation: 'drop_role', id: 'developer_test_5' })
			.expect((r) => assert.ok(r.body.error == 'Role not found'))
			.expect(404);
	});
});
