import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { testData } from '../config/envConfig.js';
import { req } from '../utils/request.js';

describe('11. Alter User Tests', () => {
	//Alter User Tests Folder

	it('Add non-SU role',  () => {
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

	it('Add User with new Role',  () => {
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

	it('Alter User with empty role',  () => {
		return req()
			.send({
				operation: 'alter_user',
				role: '',
				username: 'test_user',
				password: `${testData.password}`,
				active: true,
			})
			.expect((r) => assert.equal(r.body.error, 'If role is specified, it cannot be empty.', r.text))
			.expect(500);
	});

	it('Alter User set active to false.',  () => {
		return req()
			.send({ operation: 'alter_user', username: 'test_user', password: `${testData.password}`, active: false })
			.expect((r) =>
				assert.equal(r.body.message, 'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.equal(r.body.update_hashes[0], 'test_user', r.text))
			.expect(200);
	});

	it('Check for active=false',  () => {
		return req()
			.send({ operation: 'list_users' })
			.expect((r) => {
				let found_user = undefined;
				for (let user of r.body) {
					if (user.username === 'test_user') {
						found_user = user;
					}
				}
				assert.equal(found_user.active, false, r.text);
			})
			.expect(200);
	});

	it('Drop test user',  () => {
		return req()
			.send({ operation: 'drop_user', username: 'test_user' })
			.expect(200);
	});

	it('Drop test non-SU role',  () => {
		return req()
			.send({ operation: 'drop_role', id: 'developer_test_5' })
			.expect(200);
	});
});
