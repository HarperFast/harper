/**
 * User and role management invariants — `add_user` / `alter_user` / `drop_user` and
 * `add_role` / `alter_role` / `drop_role` against a live instance.
 *
 * A general home for this area: add sibling suites here as invariants accrue, rather than
 * one file per fix. Uses the light `startHarper` harness (no fixture) because none of these
 * roles need table permissions.
 */
import { suite, test, before, after } from 'node:test';
import assert from 'node:assert';

import { startHarper, teardownHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';

const NON_SU_ROLE = 'urm_non_su_role';
const SECOND_SU_USER = 'urm_second_su';
const SECOND_SU_PASSWORD = 'urm_second_su_pw';
const NO_SUPER_USER = /no active super_user/;

suite('User and role management', (ctx: any) => {
	let client: any;
	let adminUsername: string;
	let adminPassword: string;
	// add_user/alter_user resolve a role by NAME; alter_role updates by ID. Keep both.
	let superUserRoleName: string;
	let superUserRoleId: string;

	before(async () => {
		await startHarper(ctx, { config: {}, env: {} });
		client = createApiClient(ctx.harper);
		adminUsername = ctx.harper.admin.username;
		adminPassword = ctx.harper.admin.password;

		await client
			.req()
			.send({ operation: 'add_role', role: NON_SU_ROLE, permission: { super_user: false } })
			.expect(200);

		const users = await client.req().send({ operation: 'list_users' }).expect(200);
		const admin = users.body.find((user: any) => user.username === adminUsername);
		assert.ok(admin, `expected to find the harness admin '${adminUsername}' in list_users`);
		assert.equal(admin.role.permission.super_user, true, 'harness admin should be a super_user');
		superUserRoleName = admin.role.role;
		superUserRoleId = admin.role.id;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	/**
	 * The admin created by the harness is the instance's only super_user, so it is the account
	 * these rejections must protect. Each case asserts admin can still authenticate afterwards —
	 * that the guard rejected the change without partially applying it, which is the part unit
	 * tests cannot observe because they stub the write layer.
	 *
	 * Deliberately not covered: dropping admin *after* adding a second super_user. The guard
	 * permits it, but it would invalidate the credentials every later test in this file uses.
	 */
	suite('the last active super_user cannot be removed', () => {
		async function assertAdminStillWorks() {
			await client.req().send({ operation: 'list_users' }).expect(200);
		}

		test('drop_user is rejected for the only super_user', async () => {
			const response = await client.req().send({ operation: 'drop_user', username: adminUsername }).expect(409);
			assert.match(response.body.error, NO_SUPER_USER, JSON.stringify(response.body));
			await assertAdminStillWorks();
		});

		test('alter_user cannot demote the only super_user', async () => {
			const response = await client
				.req()
				.send({ operation: 'alter_user', username: adminUsername, role: NON_SU_ROLE })
				.expect(409);
			assert.match(response.body.error, NO_SUPER_USER, JSON.stringify(response.body));
			await assertAdminStillWorks();
		});

		test('alter_user cannot deactivate the only super_user', async () => {
			const response = await client
				.req()
				.send({ operation: 'alter_user', username: adminUsername, active: false })
				.expect(409);
			assert.match(response.body.error, NO_SUPER_USER, JSON.stringify(response.body));
			await assertAdminStillWorks();
		});

		test('alter_role cannot strip super_user from the only admin role', async () => {
			const response = await client
				.req()
				.send({ operation: 'alter_role', id: superUserRoleId, permission: { super_user: false } })
				.expect(409);
			assert.match(response.body.error, NO_SUPER_USER, JSON.stringify(response.body));
			await assertAdminStillWorks();
		});

		test('drop_user succeeds for a super_user while another remains', async () => {
			await client
				.req()
				.send({
					operation: 'add_user',
					username: SECOND_SU_USER,
					password: SECOND_SU_PASSWORD,
					role: superUserRoleName,
					active: true,
				})
				.expect(200);

			// Confirm the new account really is an active super_user, so the drop below is
			// exercising the guard's allow path rather than passing for an unrelated reason.
			await client
				.reqAs(createHeaders(SECOND_SU_USER, SECOND_SU_PASSWORD))
				.send({ operation: 'list_users' })
				.expect(200);

			await client.req().send({ operation: 'drop_user', username: SECOND_SU_USER }).expect(200);
			await assertAdminStillWorks();
		});

		// Runs last, and re-sets the same password, so the credentials the client is holding stay valid.
		test('alter_user still allows a password change on the only super_user', async () => {
			await client
				.req()
				.send({ operation: 'alter_user', username: adminUsername, password: adminPassword })
				.expect(200);
			await assertAdminStillWorks();
		});
	});
});
