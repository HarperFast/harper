/**
 * Alter User integration tests.
 *
 * Ported from legacy `apiTests/tests/11_alterUserTests.mjs`. Verifies the
 * add_role / add_user / alter_user / drop_user / drop_role operations against a
 * throwaway Harper instance.
 *
 * The legacy version assumed the `northnwd` schema/tables existed (created by
 * `1_environmentSetup`). To keep this suite hermetic, `before` creates the
 * minimum schema/tables that the role's permission map references.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarper, teardownHarper } from '@harperfast/integration-testing';
import { createApiClient } from './utils/client.mjs';

const ROLE = 'developer_test_5';
const USERNAME = 'test_user';

suite('Alter User', (ctx) => {
	let client;
	let userPassword;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		userPassword = ctx.harper.admin.password;

		// add_role validates that referenced schemas/tables/attributes exist, so
		// create the minimum schema + columns the permission map below references.
		await client.req().send({ operation: 'create_schema', schema: 'northnwd' }).expect(200);
		const tableSeed = {
			customers: { id: 1 },
			suppliers: { id: 1 },
			region: { id: 1, regiondescription: 'seed' },
			territories: { id: 1, territorydescription: 'seed' },
			categories: { id: 1, description: 'seed' },
			shippers: { id: 1, companyname: 'seed' },
		};
		for (const [table, seed] of Object.entries(tableSeed)) {
			await client
				.req()
				.send({ operation: 'create_table', schema: 'northnwd', table, hash_attribute: 'id' })
				.expect(200);
			await client
				.req()
				.send({ operation: 'insert', schema: 'northnwd', table, records: [seed] })
				.expect(200);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('Add non-SU role', () => {
		return client
			.req()
			.send({
				operation: 'add_role',
				role: ROLE,
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

	test('Add User with new Role', () => {
		return client
			.req()
			.send({
				operation: 'add_user',
				role: ROLE,
				username: USERNAME,
				password: userPassword,
				active: true,
			})
			.expect(200);
	});

	test('Alter User with empty role', () => {
		return client
			.req()
			.send({
				operation: 'alter_user',
				role: '',
				username: USERNAME,
				password: userPassword,
				active: true,
			})
			.expect((r) => assert.equal(r.body.error, 'If role is specified, it cannot be empty.', r.text))
			.expect(500);
	});

	test('Alter User set active to false', () => {
		return client
			.req()
			.send({ operation: 'alter_user', username: USERNAME, password: userPassword, active: false })
			.expect((r) =>
				assert.equal(
					r.body.message,
					'updated 1 of 1 records',
					'Expected response message to eql "updated 1 of 1 records"'
				)
			)
			.expect((r) => assert.equal(r.body.update_hashes[0], USERNAME, r.text))
			.expect(200);
	});

	test('Check for active=false', () => {
		return client
			.req()
			.send({ operation: 'list_users' })
			.expect((r) => {
				const found = r.body.find((user) => user.username === USERNAME);
				assert.ok(found, `User ${USERNAME} not found in list_users: ${r.text}`);
				assert.equal(found.active, false, r.text);
			})
			.expect(200);
	});

	test('Drop test user', () => {
		return client.req().send({ operation: 'drop_user', username: USERNAME }).expect(200);
	});

	test('Drop test non-SU role', () => {
		return client.req().send({ operation: 'drop_role', id: ROLE }).expect(200);
	});
});
