'use strict';

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
const { waitFor } = require('../waitFor');
const { databases } = require('#src/resources/databases');
const password = require('#src/utility/password');
const { server } = require('#src/server/Server');
const { Headers } = require('#src/server/serverHelpers/Headers');
const user = require('#src/security/user');
const { authentication } = require('#src/security/auth');
const { registerLiveSubscription } = require('#src/server/liveSubscriptionAuth');
const { VERSION_REUSED } = require('#src/resources/RecordEncoder');

const PASSWORD = 'lookup-password';
const hashOf = (plain) => password.hash(plain, password.HASH_FUNCTION.SHA256);

function lookupUser(overrides = {}) {
	return {
		username: 'lookup_user',
		active: true,
		password: hashOf(PASSWORD),
		hash_function: password.HASH_FUNCTION.SHA256,
		role: { id: 'lookup_role', role: 'lookup_role', permission: { super_user: false } },
		...overrides,
	};
}

function deferred() {
	let resolve;
	const promise = new Promise((yes) => (resolve = yes));
	return { promise, resolve };
}

let userChanges = 0;
user.onUserChange(() => userChanges++);

async function nextUserChange(write) {
	const before = userChanges;
	await write();
	await waitFor(() => userChanges > before, { message: 'a user-change notification arrived' });
}

describe('user and role lookups read hdb_user and hdb_role', function () {
	before(async () => {
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();
		await testUtils.ensureSystemTables();
	});

	afterEach(() => testUtils.seedUsers());

	describe('lookups', () => {
		it('finds a user written straight to hdb_user, with no refresh or signal', async () => {
			await testUtils.seedUsers([lookupUser()]);
			const found = await user.findAndValidateUser('lookup_user', PASSWORD);
			assert.strictEqual(found.username, 'lookup_user');
			assert.strictEqual(found.role.id, 'lookup_role');
			assert.ok(found.role.permission.system.tables.hdb_user, 'the role carries its system-table permissions');
		});

		it('rejects a deactivated or deleted user on the next lookup', async () => {
			await testUtils.seedUsers([lookupUser()]);
			await user.findAndValidateUser('lookup_user', PASSWORD);
			await databases.system.hdb_user.put(lookupUser({ role: 'lookup_role', active: false }));
			await assert.rejects(user.findAndValidateUser('lookup_user', PASSWORD), /inactive/);
			await databases.system.hdb_user.delete('lookup_user');
			await assert.rejects(user.findAndValidateUser('lookup_user', PASSWORD), { statusCode: 401 });
			assert.strictEqual(user.getUserWithRole('lookup_user'), undefined);
		});

		it('applies a role permission change to the next lookup', async () => {
			await testUtils.seedUsers([lookupUser()]);
			assert.strictEqual(user.getUserWithRole('lookup_user').role.permission.super_user, false);
			await databases.system.hdb_role.put({ id: 'lookup_role', role: 'lookup_role', permission: { super_user: true } });
			assert.strictEqual(user.getUserWithRole('lookup_user').role.permission.super_user, true);
		});

		it('shares the derived role across lookups until the role record changes', async () => {
			await testUtils.seedUsers([lookupUser()]);
			const first = user.getUserWithRole('lookup_user');
			const second = user.getUserWithRole('lookup_user');
			assert.notStrictEqual(first.role, second.role);
			assert.strictEqual(first.role.permission.system, second.role.permission.system);
			await databases.system.hdb_role.put({ id: 'lookup_role', role: 'lookup_role', permission: {} });
			assert.notStrictEqual(user.getUserWithRole('lookup_user').role.permission.system, first.role.permission.system);
		});

		it('hands each lookup a role it can modify without affecting later lookups', async () => {
			await testUtils.seedUsers([
				lookupUser({ role: { id: 'lookup_role', role: 'lookup_role', permission: { super_user: true } } }),
			]);
			const first = user.getUserWithRole('lookup_user');
			first.role.permission.super_user = false;
			first.role.permission = {};
			assert.strictEqual(user.getUserWithRole('lookup_user').role.permission.super_user, true);
		});

		for (const [label, staleFlags] of [
			['numbered', 0],
			['reused', VERSION_REUSED],
		]) {
			it(`pairs the user with the role it references in the state it re-read (${label} version)`, async () => {
				// One transaction moves the user from role A to role B and grants A super_user: a lookup whose
				// user read lands before it and whose role read lands after must not combine the two.
				await testUtils.seedUsers([
					lookupUser({ role: { id: 'lookup_role_b', role: 'lookup_role_b', permission: { super_user: false } } }),
					{
						username: 'lookup_role_a_holder',
						role: { id: 'lookup_role_a', role: 'lookup_role_a', permission: { super_user: true } },
					},
				]);
				const userStore = databases.system.hdb_user.primaryStore;
				const ownGetEntry = Object.hasOwn(userStore, 'getEntry') ? userStore.getEntry : undefined;
				const getEntry = userStore.getEntry;
				let staleReadPending = true;
				userStore.getEntry = function (id, options) {
					const entry = getEntry.call(this, id, options);
					if (!staleReadPending || id !== 'lookup_user') return entry;
					staleReadPending = false;
					return {
						...entry,
						value: { ...entry.value, role: 'lookup_role_a' },
						version: staleFlags ? entry.version : entry.version - 1,
						metadataFlags: (entry.metadataFlags ?? 0) | staleFlags,
					};
				};
				try {
					const found = user.getUserWithRole('lookup_user');
					assert.strictEqual(staleReadPending, false, 'the lookup made the stale read');
					assert.strictEqual(found.role.id, 'lookup_role_b');
					assert.strictEqual(found.role.permission.super_user, false);
				} finally {
					if (ownGetEntry) userStore.getEntry = ownGetEntry;
					else delete userStore.getEntry;
				}
			});
		}

		it('returns a user a resequenced write left on a reused version, and compares it by value', async function () {
			// only the RocksDB encoder keeps an out-of-order write under the existing version
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			await testUtils.seedUsers([lookupUser({ logins: 0 })]);
			const now = Date.now();
			const login = { logins: { __op__: 'add', value: 1 } };
			await databases.system.hdb_user.patch('lookup_user', login, { timestamp: now + 100 });
			// out of order: merged onto the newer record and stored under its version
			await databases.system.hdb_user.patch('lookup_user', login, { timestamp: now + 50 });
			const entry = databases.system.hdb_user.primaryStore.getEntry('lookup_user');
			assert.ok(entry.metadataFlags & VERSION_REUSED, 'the record carries a reused version');
			const found = user.getUserWithRole('lookup_user');
			assert.strictEqual(found.role.id, 'lookup_role');
			assert.strictEqual(user.isCurrentUser(found), true, 'an unchanged value is still current');
			await databases.system.hdb_user.patch('lookup_user', { active: false }, { timestamp: now + 25 });
			assert.strictEqual(user.isCurrentUser(found), false, 'a changed value is not');
			// later writes in this suite must not lose to the future timestamp
			await new Promise((resolve) => setTimeout(resolve, 150));
		});

		it('re-checks the super user it remembered', async () => {
			const remembered = await user.getSuperUser();
			const superUserRoleId = remembered.role.id;
			await testUtils.seedUsers([
				{ username: remembered.username, active: true, role: { role: 'demoted', permission: {} } },
				{ username: 'zz_lookup_super_user', active: true, role: superUserRoleId },
			]);
			const current = await user.getSuperUser();
			assert.notStrictEqual(current.username, remembered.username, 'the demoted user is not returned');
			assert.strictEqual(current.role.role, 'super_user');
		});

		it('treats a username over the LMDB key-size limit as unauthenticatable, not an internal fault', () => {
			assert.strictEqual(user.getUserWithRole('x'.repeat(2000)), undefined);
			// ordered-binary escapes low control characters to 2 bytes each, so UTF-8 byte length alone
			// would pass this well under the limit while the encoded key exceeds it
			assert.strictEqual(user.getUserWithRole('\u0001'.repeat(1000)), undefined);
		});

		it('lists users when a role written straight to hdb_role has no permission', async () => {
			await testUtils.seedUsers([
				lookupUser(),
				lookupUser({
					username: 'lookup_user_malformed_role',
					role: { id: 'malformed_role', role: 'malformed_role' },
				}),
			]);
			const listed = await user.listUsers();
			assert.strictEqual(listed.get('lookup_user').role.id, 'lookup_role');
			assert.strictEqual(listed.get('lookup_user_malformed_role').role.permission, undefined);
		});
	});

	describe('isCurrentUser', () => {
		it('holds until the user or role record the user was built from changes', async () => {
			await testUtils.seedUsers([lookupUser()]);
			let found = await user.findAndValidateUser('lookup_user', PASSWORD);
			assert.strictEqual(user.isCurrentUser(found), true);
			await databases.system.hdb_user.put(lookupUser({ role: 'lookup_role', password: hashOf('changed') }));
			assert.strictEqual(user.isCurrentUser(found), false, 'a password change');

			found = user.getUserWithRole('lookup_user');
			assert.strictEqual(user.isCurrentUser(found), true);
			await databases.system.hdb_role.put({ id: 'lookup_role', role: 'lookup_role', permission: {} });
			assert.strictEqual(user.isCurrentUser(found), false, 'a role change');

			found = user.getUserWithRole('lookup_user');
			await databases.system.hdb_user.delete('lookup_user');
			assert.strictEqual(user.isCurrentUser(found), false, 'a deleted user');
		});

		it('holds for an unknown user only until that user is created', async () => {
			const unknown = await user.findAndValidateUser('lookup_user', null, false);
			assert.strictEqual(unknown.role, undefined);
			assert.strictEqual(user.isCurrentUser(unknown), true);
			await testUtils.seedUsers([lookupUser()]);
			assert.strictEqual(user.isCurrentUser(unknown), false);
		});

		it('treats a user this module did not build as current', () => {
			assert.strictEqual(user.isCurrentUser({ username: 'scoped', role: { permission: {} } }), true);
		});
	});

	describe('authentication() authorization cache', () => {
		const basic = (username, plain) => 'Basic ' + Buffer.from(`${username}:${plain}`).toString('base64');
		async function authenticate(authorization) {
			let authenticated;
			const response = await authentication(
				{
					headers: { asObject: { authorization, host: 'localhost' } },
					method: 'POST',
					pathname: '/',
					ip: '10.0.0.1',
					isOperationsServer: true,
				},
				async (request) => {
					authenticated = request.user;
					return { status: 200, headers: new Headers(), body: {} };
				}
			);
			return { status: response.status, user: authenticated };
		}

		it('re-verifies a cached Basic credential once the password changes', async () => {
			await testUtils.seedUsers([lookupUser()]);
			const header = basic('lookup_user', PASSWORD);
			assert.strictEqual((await authenticate(header)).status, 200);
			assert.strictEqual((await authenticate(header)).status, 200);
			await databases.system.hdb_user.put(lookupUser({ role: 'lookup_role', password: hashOf('changed') }));
			assert.strictEqual((await authenticate(header)).status, 401);
			assert.strictEqual((await authenticate(basic('lookup_user', 'changed'))).status, 200);
		});

		it('rejects a cached Basic credential once the user is deactivated', async () => {
			await testUtils.seedUsers([lookupUser()]);
			const header = basic('lookup_user', PASSWORD);
			assert.strictEqual((await authenticate(header)).status, 200);
			await databases.system.hdb_user.put(lookupUser({ role: 'lookup_role', active: false }));
			assert.strictEqual((await authenticate(header)).status, 401);
		});

		it('serves the current role on a cached Basic credential', async () => {
			await testUtils.seedUsers([lookupUser()]);
			const header = basic('lookup_user', PASSWORD);
			assert.strictEqual((await authenticate(header)).user.role.permission.super_user, false);
			await databases.system.hdb_role.put({ id: 'lookup_role', role: 'lookup_role', permission: { super_user: true } });
			assert.strictEqual((await authenticate(header)).user.role.permission.super_user, true);
		});

		it('re-resolves a component-provided principal once the records for its name change', async () => {
			await testUtils.seedUsers([lookupUser()]);
			const getUser = server.getUser;
			let resolutions = 0;
			server.getUser = async (username) => {
				resolutions++;
				return { username, role: { role: 'component_role', permission: {} } };
			};
			try {
				const header = basic('lookup_user', 'any');
				await authenticate(header);
				await authenticate(header);
				assert.strictEqual(resolutions, 1, 'the principal is cached');
				await databases.system.hdb_user.put(lookupUser({ role: 'lookup_role', active: false }));
				await authenticate(header);
				assert.strictEqual(resolutions, 2);
			} finally {
				server.getUser = getUser;
			}
		});
	});

	describe('onUserChange', () => {
		it('notifies after a write to hdb_user and after a write to hdb_role', async () => {
			await nextUserChange(() => testUtils.seedUsers([lookupUser()]));
			await nextUserChange(() =>
				databases.system.hdb_role.put({ id: 'lookup_role', role: 'lookup_role', permission: {} })
			);
		});

		it('keeps notifying the other listeners when one throws or rejects', async () => {
			user.onUserChange(() => {
				throw new Error('listener failure');
			});
			user.onUserChange(() => Promise.reject(new Error('async listener failure')));
			await nextUserChange(() => testUtils.seedUsers([lookupUser()]));
		});

		it('re-runs a live-subscription sweep for a change that lands while one is running', async () => {
			const gate = deferred();
			let rechecks = 0;
			const handle = registerLiveSubscription({
				username: 'lookup_user',
				recheck: async () => {
					if (++rechecks === 1) await gate.promise;
					return true;
				},
				revoke: () => {},
			});
			try {
				await testUtils.seedUsers([lookupUser()]);
				await waitFor(() => rechecks >= 1, { message: 'the first sweep started' });
				const during = rechecks;
				await databases.system.hdb_role.put({ id: 'lookup_role', role: 'lookup_role', permission: {} });
				gate.resolve();
				await waitFor(() => rechecks > during, { message: 'a sweep ran for the change made during the first' });
			} finally {
				gate.resolve();
				handle.unregister();
			}
		});
	});
});
