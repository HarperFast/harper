'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const sinon = require('sinon');
const rewire = require('rewire');

const user_rw = rewire('#src/security/user');
const role_rw = rewire('#src/security/role');
// role.js resolves assertActiveSuperUserRemains through the normally-cached user module, which is a
// different instance than the rewired one, so the guard's cache has to be seeded on both.
const user_plain = require('#src/security/user');

const sandbox = sinon.createSandbox();

const SUPER_ROLE = { id: 'super_user', role: 'super_user', permission: { super_user: true } };
const APP_ROLE = { id: 'cal_organizer', role: 'cal_organizer', permission: { super_user: false } };

function userRecord(username, role, active = true) {
	return { username, active, role, password: 'hash', hash_function: 'sha256' };
}

/** Seeds the resolved user/role auth cache the guard reads from. */
function seedUsers(...users) {
	const cache = new Map(users.map((u) => [u.username, u]));
	return Promise.all([user_rw.setUsersWithRolesCache(cache), user_plain.setUsersWithRolesCache(cache)]);
}

async function rejects(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return undefined;
}

describe('security/user.js last-super_user guard', () => {
	afterEach(() => {
		sandbox.restore();
	});

	describe('assertActiveSuperUserRemains()', () => {
		it('rejects a change that removes the only active super_user', async () => {
			await seedUsers(userRecord('admin', SUPER_ROLE));

			const error = await rejects(
				user_rw.assertActiveSuperUserRemains((u) => (u.username === 'admin' ? undefined : u))
			);

			assert.ok(error, 'expected the guard to reject');
			assert.match(error.message, /no active super_user/);
			assert.strictEqual(error.statusCode, 409);
		});

		it('allows the change when another active super_user remains', async () => {
			await seedUsers(userRecord('admin', SUPER_ROLE), userRecord('second', SUPER_ROLE));

			await user_rw.assertActiveSuperUserRemains((u) => (u.username === 'admin' ? undefined : u));
		});

		it('rejects demoting the only super_user to a role without the permission', async () => {
			await seedUsers(userRecord('admin', SUPER_ROLE));

			const error = await rejects(
				user_rw.assertActiveSuperUserRemains((u) => (u.username === 'admin' ? { ...u, role: APP_ROLE } : u))
			);

			assert.ok(error, 'expected the guard to reject a demotion');
		});

		it('rejects deactivating the only super_user', async () => {
			await seedUsers(userRecord('admin', SUPER_ROLE));

			const error = await rejects(
				user_rw.assertActiveSuperUserRemains((u) => (u.username === 'admin' ? { ...u, active: false } : u))
			);

			assert.ok(error, 'expected the guard to reject a deactivation');
		});

		it('does not count an inactive super_user as remaining', async () => {
			await seedUsers(userRecord('admin', SUPER_ROLE), userRecord('dormant', SUPER_ROLE, false));

			const error = await rejects(
				user_rw.assertActiveSuperUserRemains((u) => (u.username === 'admin' ? undefined : u))
			);

			assert.ok(error, 'an inactive super_user cannot administer the instance');
		});

		it('allows the change when no active super_user exists already, so repair is not blocked', async () => {
			await seedUsers(userRecord('ethan', APP_ROLE));

			await user_rw.assertActiveSuperUserRemains((u) => (u.username === 'ethan' ? undefined : u));
		});

		it('rejects stripping super_user from the role the only admin depends on', async () => {
			await seedUsers(userRecord('admin', SUPER_ROLE));

			const error = await rejects(
				user_rw.assertActiveSuperUserRemains((u) =>
					u.role?.id === 'super_user' ? { ...u, role: { ...u.role, permission: { super_user: false } } } : u
				)
			);

			assert.ok(error, 'expected the guard to reject the role-permission strip');
		});
	});

	// The guard's logic is only half the fix -- each call site has to pass a `simulate` that
	// describes its own pending change. These cover that wiring, and that no write is attempted.
	describe('call sites', () => {
		it('alterUser refuses to demote the last super_user and does not write', async () => {
			await seedUsers(userRecord('admin', SUPER_ROLE));
			const update = sandbox.stub().resolves({ message: 'updated 1 of 1 records' });
			user_rw.__set__('insert', { update, insert: sandbox.stub() });
			user_rw.__set__('search', { searchByValue: sandbox.stub().resolves([APP_ROLE]) });

			const error = await rejects(user_rw.alterUser({ username: 'admin', role: 'cal_organizer' }));

			assert.ok(error, 'expected alter_user to be rejected');
			assert.match(error.message, /no active super_user/);
			assert.strictEqual(update.callCount, 0, 'the user row must not be updated');
		});

		it('alterUser refuses to deactivate the last super_user', async () => {
			await seedUsers(userRecord('admin', SUPER_ROLE));
			const update = sandbox.stub().resolves({});
			user_rw.__set__('insert', { update, insert: sandbox.stub() });

			const error = await rejects(user_rw.alterUser({ username: 'admin', active: false }));

			assert.ok(error, 'expected active:false on the last super_user to be rejected');
			assert.strictEqual(update.callCount, 0, 'the user row must not be updated');
		});

		it('alterUser still allows a password-only change on the last super_user', async () => {
			await seedUsers(userRecord('admin', SUPER_ROLE));
			const update = sandbox.stub().resolves({ message: 'updated 1 of 1 records' });
			user_rw.__set__('insert', { update, insert: sandbox.stub() });
			user_rw.__set__('search', { searchByValue: sandbox.stub().resolves([]) });
			user_rw.__set__('signalling', { signalUserChange: sandbox.stub().resolves() });

			await user_rw.alterUser({ username: 'admin', password: 'a-new-password' });

			assert.strictEqual(update.callCount, 1, 'a password rotation must not be blocked');
		});

		it('dropUser refuses to delete the last super_user and does not delete', async () => {
			await seedUsers(userRecord('admin', SUPER_ROLE));
			const deleteStub = sandbox.stub().yields(null, {});
			user_rw.__set__('delete_', { delete_: deleteStub });

			const error = await rejects(user_rw.dropUser({ username: 'admin' }));

			assert.ok(error, 'expected drop_user to be rejected');
			assert.match(error.message, /no active super_user/);
			assert.strictEqual(deleteStub.callCount, 0, 'the user row must not be deleted');
		});

		it('alterRole refuses to strip super_user from the last admin role and does not write', async () => {
			await seedUsers(userRecord('admin', SUPER_ROLE));
			const update = sandbox.stub().resolves({ message: 'updated 1 of 1 records' });
			role_rw.__set__('insert', { update });

			const error = await rejects(
				role_rw.alterRole({ id: 'super_user', role: 'super_user', permission: { super_user: false } })
			);

			assert.ok(error, 'expected alter_role to be rejected');
			assert.match(error.message, /no active super_user/);
			assert.strictEqual(update.callCount, 0, 'the role row must not be updated');
		});
	});
});
