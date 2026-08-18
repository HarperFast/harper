'use strict';

const assert = require('node:assert');
const { activeSuperUserRemains } = require('#src/security/superUserGuard');

const SUPER_ROLE = { id: 'super_user', role: 'super_user', permission: { super_user: true } };
const APP_ROLE = { id: 'cal_organizer', role: 'cal_organizer', permission: { super_user: false } };

function user(username, role, active = true) {
	return { username, active, role };
}

const removing = (username) => (candidate) => (candidate.username === username ? undefined : candidate);
const changing = (username, changes) => (candidate) =>
	candidate.username === username ? { ...candidate, ...changes } : candidate;

describe('security/superUserGuard', () => {
	describe('activeSuperUserRemains()', () => {
		it('is false when the change removes the only active super_user', () => {
			assert.equal(activeSuperUserRemains([user('admin', SUPER_ROLE)], removing('admin')), false);
		});

		it('is true when another active super_user remains', () => {
			const users = [user('admin', SUPER_ROLE), user('second', SUPER_ROLE)];
			assert.equal(activeSuperUserRemains(users, removing('admin')), true);
		});

		it('is false when the only super_user is demoted to a role without the permission', () => {
			const users = [user('admin', SUPER_ROLE)];
			assert.equal(activeSuperUserRemains(users, changing('admin', { role: APP_ROLE })), false);
		});

		it('is false when the only super_user is deactivated', () => {
			const users = [user('admin', SUPER_ROLE)];
			assert.equal(activeSuperUserRemains(users, changing('admin', { active: false })), false);
		});

		it('does not count an inactive super_user as remaining', () => {
			const users = [user('admin', SUPER_ROLE), user('dormant', SUPER_ROLE, false)];
			assert.equal(activeSuperUserRemains(users, removing('admin')), false);
		});

		it('is true when no active super_user exists beforehand, so a repair is not blocked', () => {
			assert.equal(activeSuperUserRemains([user('ethan', APP_ROLE)], removing('ethan')), true);
		});

		it('is false when the permission is stripped from the role the only admin depends on', () => {
			const users = [user('admin', SUPER_ROLE)];
			const strip = (candidate) =>
				candidate.role?.id === 'super_user'
					? { ...candidate, role: { ...candidate.role, permission: { super_user: false } } }
					: candidate;
			assert.equal(activeSuperUserRemains(users, strip), false);
		});

		it('is true when the permission is stripped from a role no active super_user uses', () => {
			const users = [user('admin', SUPER_ROLE), user('ethan', APP_ROLE)];
			const strip = (candidate) =>
				candidate.role?.id === 'cal_organizer'
					? { ...candidate, role: { ...candidate.role, permission: { super_user: false } } }
					: candidate;
			assert.equal(activeSuperUserRemains(users, strip), true);
		});

		it('tolerates a user with no role at all', () => {
			const users = [user('admin', SUPER_ROLE), user('roleless', undefined)];
			assert.equal(activeSuperUserRemains(users, removing('roleless')), true);
		});

		it('is true for an unrelated change that touches no super_user', () => {
			const users = [user('admin', SUPER_ROLE), user('ethan', APP_ROLE)];
			assert.equal(activeSuperUserRemains(users, changing('ethan', { active: false })), true);
		});
	});
});
