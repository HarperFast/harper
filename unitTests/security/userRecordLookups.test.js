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
const { getDeferredCredentialRejection } = require('#src/security/deferredAuthentication');
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

		it('finds a super user from the current records, not one an earlier call returned', async () => {
			const earlier = await user.getSuperUser();
			const superUserRoleId = earlier.role.id;
			await testUtils.seedUsers([
				{ username: earlier.username, active: true, role: { role: 'demoted', permission: {} } },
				{ username: 'zz_lookup_super_user', active: true, role: superUserRoleId },
			]);
			const current = await user.getSuperUser();
			assert.notStrictEqual(current.username, earlier.username, 'the demoted user is not returned');
			assert.strictEqual(current.role.permission.super_user, true);
		});

		it('treats a username over the LMDB key-size limit as unauthenticatable, not an internal fault', () => {
			assert.strictEqual(user.getUserWithRole('x'.repeat(2000)), undefined);
			// ordered-binary escapes U+0000-U+0003 to two bytes each: 1000 characters here encode past the key limit
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

		it('tells a user built from an hdb_user record from one with no record', async () => {
			const unknown = await user.findAndValidateUser('lookup_user', null, false);
			assert.strictEqual(user.isRecordBacked(unknown), false);
			assert.strictEqual(user.isRecordBacked(user.cloneUserView(unknown)), false, 'a role-less clone');
			await testUtils.seedUsers([lookupUser({ role: 'missing_role' })]);
			const roleless = await user.findAndValidateUser('lookup_user', null, false);
			assert.strictEqual(roleless.role, undefined);
			assert.strictEqual(user.isRecordBacked(roleless), true, 'a record whose role is missing');
			assert.strictEqual(user.isRecordBacked({ username: 'scoped', role: { permission: {} } }), undefined);
		});

		it('tells the refusal of an inactive user from other lookup failures', async () => {
			await testUtils.seedUsers([lookupUser({ active: false })]);
			const inactive = await user.findAndValidateUser('lookup_user', null, false).catch((error) => error);
			assert.strictEqual(user.isInactiveUserRejection(inactive), true);
			const wrongPassword = await user.findAndValidateUser('nobody_cn', 'x').catch((error) => error);
			assert.strictEqual(user.isInactiveUserRejection(wrongPassword), false);
			assert.strictEqual(
				user.isInactiveUserRejection(new Error(inactive.message)),
				false,
				"only the lookup's own refusal"
			);
		});

		it('marks a copy as a certificate principal, never the object server.getUser returned', async () => {
			const unknown = await user.findAndValidateUser('lookup_user', null, false);
			const named = user.certificatePrincipal(unknown);
			assert.notStrictEqual(named, unknown);
			assert.strictEqual(user.isCertificatePrincipal(named), true);
			assert.strictEqual(user.isCertificatePrincipal(unknown), false, 'the shared object stays unmarked');
			assert.strictEqual(user.isRecordBacked(named), false, 'the copy keeps its record provenance');
			assert.strictEqual(user.isCertificatePrincipal(user.cloneUserView(named)), true, 'a clone keeps the mark');
			assert.strictEqual(user.certificateAdmission(named), named, 'the copy is the admission');
			assert.strictEqual(user.certificateAdmission(user.cloneUserView(named)), named, 'a clone keeps the admission');
			const again = user.certificatePrincipal(named);
			assert.strictEqual(user.certificateAdmission(again), again, 'a new admission of a marked object is its own');
			assert.strictEqual(
				user.certificateAdmission(user.cloneUserView(unknown, undefined, named)),
				named,
				"a recheck's view carries the admission it replaced"
			);
			const carried = user.withCertificateAdmission({ username: 'lookup_user' }, named);
			assert.strictEqual(user.certificateAdmission(carried), named);
			const plain = { username: 'lookup_user' };
			assert.strictEqual(
				user.withCertificateAdmission(plain, unknown),
				plain,
				'nothing to carry from an unmarked user'
			);
			assert.strictEqual(
				user.isCertificatePrincipal(JSON.parse(JSON.stringify(named))),
				false,
				'data never carries it'
			);
			assert.strictEqual(user.isCertificatePrincipal(structuredClone(named)), false);

			const frozen = Object.freeze({ username: 'frozen_cn' });
			assert.strictEqual(user.isCertificatePrincipal(user.certificatePrincipal(frozen)), true);
			for (const none of [null, undefined]) assert.strictEqual(user.certificatePrincipal(none), none);

			const component = { username: 'component_cn', role: { permission: {} } };
			user.trackUserRecords(component, user.userRecordVersions('component_cn'));
			await testUtils.seedUsers([lookupUser({ username: 'component_cn' })]);
			assert.strictEqual(
				user.isCurrentUser(user.certificatePrincipal(component)),
				false,
				'tracked versions carry over'
			);
		});

		it('keeps a certificate view of a record-backed user current only while its records are', async () => {
			await testUtils.seedUsers([lookupUser()]);
			const view = user.certificatePrincipal(await user.findAndValidateUser('lookup_user', null, false));
			assert.strictEqual(user.isRecordBacked(view), true);
			assert.strictEqual(user.isCurrentUser(view), true);
			await databases.system.hdb_role.put({ id: 'lookup_role', role: 'lookup_role', permission: {} });
			assert.strictEqual(user.isCurrentUser(view), false, 'a role change');
		});

		it("marks the built-in lookup's new view in place, and copies what another resolver returned", async () => {
			const { server } = require('#src/server/Server');
			const builtIn = await server.getUser('lookup_user', null);
			assert.strictEqual(
				user.certificatePrincipal(builtIn, server.getUser),
				builtIn,
				'no copy of a view only it holds'
			);
			assert.strictEqual(user.isCertificatePrincipal(builtIn), true);
			assert.strictEqual(user.certificateAdmission(builtIn), builtIn, 'the view is its own admission');

			const fromOverride = await user.findAndValidateUser('lookup_user', null, false);
			const named = user.certificatePrincipal(fromOverride, async () => fromOverride);
			assert.notStrictEqual(named, fromOverride);
			assert.strictEqual(user.isCertificatePrincipal(fromOverride), false, 'another resolver may share it');
			assert.strictEqual(user.isCertificatePrincipal(named), true);
		});

		it('copies and marks a plain object from another realm, or with a null prototype', () => {
			const vm = require('node:vm');
			const otherRealm = vm.runInNewContext('({ username: "realm_cn" })');
			assert.notStrictEqual(Object.getPrototypeOf(otherRealm), Object.prototype);
			const bare = Object.assign(Object.create(null), { username: 'bare_cn' });
			for (const principal of [otherRealm, bare]) {
				const named = user.certificatePrincipal(principal);
				assert.notStrictEqual(named, principal);
				assert.strictEqual(user.isCertificatePrincipal(named), true);
				assert.strictEqual(named.username, principal.username);
			}
		});

		it('leaves a plain object with a non-enumerable own property as it is, unmarked', () => {
			const hidden = Object.defineProperty({ username: 'hidden_cn' }, 'authExpiresAt', { value: 1, enumerable: false });
			assert.strictEqual(user.certificatePrincipal(hidden), hidden, 'a copy would drop its expiry');
			assert.strictEqual(user.isCertificatePrincipal(hidden), false);
		});

		it('leaves an object on any other null-rooted prototype as it is, unmarked', () => {
			class Detached extends null {
				constructor() {
					return Object.create(Detached.prototype);
				}
				get authExpiresAt() {
					return 1;
				}
			}
			const detached = new Detached();
			detached.username = 'detached_cn';
			const prototype = Object.create(null, { authExpiresAt: { get: () => 1 } });
			const custom = Object.assign(Object.create(prototype), { username: 'custom_cn' });
			for (const principal of [detached, custom]) {
				assert.strictEqual(user.certificatePrincipal(principal), principal, 'a copy would drop its getters');
				assert.strictEqual(user.isCertificatePrincipal(principal), false);
			}
		});

		it('leaves a class-instance principal as it is, unmarked', () => {
			class GetterRole {
				username = 'getter_cn';
				get role() {
					return { permission: {} };
				}
			}
			class PrivateName {
				#name = 'private_cn';
				get username() {
					return this.#name;
				}
			}
			for (const principal of [new GetterRole(), new PrivateName()]) {
				assert.strictEqual(user.certificatePrincipal(principal), principal);
				assert.strictEqual(user.isCertificatePrincipal(principal), false);
			}
		});

		it('treats a user this module did not build as current', () => {
			assert.strictEqual(user.isCurrentUser({ username: 'scoped', role: { permission: {} } }), true);
		});

		it('checks a cloned view against the records the original was built from', async () => {
			await testUtils.seedUsers([lookupUser()]);
			const found = await user.findAndValidateUser('lookup_user', PASSWORD);
			const view = user.cloneUserView(found);
			assert.notStrictEqual(view.role.permission, found.role.permission);
			assert.strictEqual(user.isCurrentUser(view), true);
			await databases.system.hdb_role.put({ id: 'lookup_role', role: 'lookup_role', permission: {} });
			assert.strictEqual(user.isCurrentUser(view), false);
			assert.strictEqual(user.isCurrentUser(user.cloneUserView(view)), false, 'a clone of a clone');
		});
	});

	describe('isRecordlessPrincipal', () => {
		const componentUser = (username) => ({ username, role: { role: 'component_role', permission: {} } });
		function resolvedFor(loginName, principal) {
			user.trackUserRecords(principal, user.userRecordVersions(loginName));
			return principal;
		}

		it('holds for a principal resolved for a name with no record, after a record takes that name too', async () => {
			const unbacked = resolvedFor('lookup_unbacked', componentUser('lookup_unbacked'));
			assert.strictEqual(user.isRecordlessPrincipal(unbacked), true);
			assert.strictEqual(user.isRecordlessPrincipal(user.cloneUserView(unbacked)), true, 'and a view of it');
			await testUtils.seedUsers([lookupUser({ username: 'lookup_unbacked' })]);
			assert.strictEqual(user.isRecordlessPrincipal(unbacked), true, 'a record created later is another principal’s');
			assert.strictEqual(user.isCurrentUser(unbacked), false);
		});

		it('does not hold where a record has the name, or was created while it resolved', async () => {
			const versions = user.userRecordVersions('lookup_user');
			await testUtils.seedUsers([lookupUser()]);
			const raced = componentUser('lookup_user');
			user.trackUserRecords(raced, versions);
			assert.strictEqual(user.isRecordlessPrincipal(raced), false, 'created while it resolved');
			assert.strictEqual(user.isRecordlessPrincipal(resolvedFor('lookup_user', componentUser('lookup_user'))), false);
			assert.strictEqual(user.isRecordlessPrincipal(await user.findAndValidateUser('lookup_user', PASSWORD)), false);
		});

		it('does not hold where a record with its name was dropped, before or while it resolved', async () => {
			await testUtils.seedUsers([lookupUser({ username: 'lookup_dropped' })]);
			await databases.system.hdb_user.delete('lookup_dropped');
			const dropped = resolvedFor('lookup_dropped', componentUser('lookup_dropped'));
			assert.strictEqual(user.isRecordlessPrincipal(dropped), false, 'the drop’s tombstone is still kept');
			assert.strictEqual(user.hasRecordProvenance(dropped), false, 'so its holders re-read it by name each pass');
			assert.strictEqual(user.isCurrentUser(dropped), true, 'though nothing changed while it resolved');

			await testUtils.seedUsers([lookupUser({ username: 'lookup_alias_dropped' })]);
			const getUser = server.getUser;
			server.getUser = async () => {
				const copied = structuredClone(user.getUserWithRole('lookup_alias_dropped'));
				await databases.system.hdb_user.delete('lookup_alias_dropped');
				return copied;
			};
			try {
				const aliased = await user.getTrackedUser('lookup_alias_login', 'token');
				assert.strictEqual(aliased.username, 'lookup_alias_dropped');
				assert.strictEqual(
					user.isRecordlessPrincipal(aliased),
					false,
					'dropped while a login under another name resolved'
				);
				assert.strictEqual(user.isCurrentUser(aliased), false);
			} finally {
				server.getUser = getUser;
			}
		});

		it('does not hold for a user under another name on an unaudited hdb_user, which keeps no tombstone', async () => {
			const userTable = databases.system.hdb_user;
			const audited = userTable.audit;
			await testUtils.seedUsers([lookupUser({ username: 'lookup_unaudited_dropped' })]);
			const getUser = server.getUser;
			server.getUser = async () => {
				const copied = structuredClone(user.getUserWithRole('lookup_unaudited_dropped'));
				await userTable.delete('lookup_unaudited_dropped');
				userTable.primaryStore.removeSync('lookup_unaudited_dropped');
				return copied;
			};
			userTable.audit = false;
			try {
				const aliased = await user.getTrackedUser('lookup_unaudited_login', 'token');
				assert.strictEqual(userTable.primaryStore.getEntry('lookup_unaudited_dropped'), undefined, 'no tombstone');
				assert.strictEqual(user.isRecordlessPrincipal(aliased), false, 'dropped while it resolved, for all it shows');
				assert.strictEqual(user.hasRecordProvenance(aliased), false, 'so its holders re-read it by name each pass');
				assert.strictEqual(user.isCurrentUser(aliased), true, 'and a Bearer login of it is not refused');
				const renamed = resolvedFor('lookup_unaudited_token', componentUser('lookup_unaudited_subject'));
				assert.strictEqual(user.isRecordlessPrincipal(renamed), false, 'nor one whose name never had a record');
				assert.strictEqual(user.hasRecordProvenance(renamed), false);
				assert.strictEqual(user.isCurrentUser(renamed), true);
				const unbacked = resolvedFor('lookup_unaudited_unbacked', componentUser('lookup_unaudited_unbacked'));
				assert.strictEqual(user.isRecordlessPrincipal(unbacked), true, 'its own name was read before it resolved');
			} finally {
				userTable.audit = audited;
				server.getUser = getUser;
			}
		});

		it('does not hold for a user this module built, or one with nothing recorded', async () => {
			assert.strictEqual(user.isRecordlessPrincipal(await user.findAndValidateUser('lookup_user', null, false)), false);
			assert.strictEqual(user.isRecordlessPrincipal(componentUser('lookup_untracked')), false);
		});

		it('tracks the user a component returns, and keeps what a memoizing component’s first lookup recorded', async () => {
			class ComponentUser {
				#clientId;
				constructor(username) {
					this.username = username;
					this.#clientId = `client-${username}`;
				}
				get client_id() {
					return this.#clientId;
				}
			}
			const getUser = server.getUser;
			const shared = new ComponentUser('lookup_memo');
			server.getUser = async () => shared;
			try {
				const first = await user.getTrackedUser('lookup_memo', 'token');
				assert.strictEqual(await user.getTrackedUser('lookup_memo', 'token'), shared, 'nothing changed in between');
				await testUtils.seedUsers([lookupUser({ username: 'lookup_memo' })]);
				const second = await user.getTrackedUser('lookup_memo', 'token');
				assert.strictEqual(first, shared, 'the first lookup keeps what the component returned');
				assert.strictEqual(second, shared, 'and so does one after a record change');
				assert.strictEqual(second.client_id, 'client-lookup_memo', 'with its private fields');
				assert.strictEqual(user.isRecordlessPrincipal(shared), true, 'a record created later is another principal’s');
			} finally {
				server.getUser = getUser;
			}
		});

		it('keeps a memoized principal returned under another name, and one whose record was dropped', async () => {
			const getUser = server.getUser;
			const renamed = componentUser('lookup_memo_subject');
			server.getUser = async () => renamed;
			try {
				assert.strictEqual(await user.getTrackedUser('lookup_memo_login', 'token'), renamed);
				assert.strictEqual(await user.getTrackedUser('lookup_memo_login', 'token'), renamed, 'on a repeat login');
				assert.strictEqual(user.isRecordlessPrincipal(renamed), true);

				await testUtils.seedUsers([lookupUser()]);
				const copied = structuredClone(user.getUserWithRole('lookup_user'));
				server.getUser = async () => copied;
				assert.strictEqual(await user.getTrackedUser('lookup_user', 'token'), copied);
				await databases.system.hdb_user.delete('lookup_user');
				assert.strictEqual(await user.getTrackedUser('lookup_user', 'token'), copied);
				assert.strictEqual(user.isRecordlessPrincipal(copied), false, 'its first lookup read its record');
				assert.strictEqual(user.isCurrentUser(copied), false, 'so the drop shows as a change');
			} finally {
				server.getUser = getUser;
			}
		});

		it('tracks a principal returned under another name by the records for that name', async () => {
			await testUtils.seedUsers([lookupUser()]);
			const renamed = resolvedFor('lookup_token_login', componentUser('lookup_token_subject'));
			assert.strictEqual(user.isRecordlessPrincipal(renamed), true, 'no record has either name');
			const admitted = resolvedFor('lookup_user', componentUser('lookup_token_subject'));
			assert.strictEqual(user.isRecordlessPrincipal(admitted), false, 'the login name’s record may have admitted it');
			const aliased = resolvedFor('lookup_alias', structuredClone(user.getUserWithRole('lookup_user')));
			assert.strictEqual(user.isRecordlessPrincipal(aliased), false, 'a copy of a record-backed user');
			await databases.system.hdb_user.delete('lookup_user');
			assert.strictEqual(user.isCurrentUser(aliased), false, 'it is checked against the record it copied');
			assert.strictEqual(user.isCurrentUser(admitted), false, 'and against the login name’s record');
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

		it('hands the request a user that isCurrentUser checks against its records, cached or not', async () => {
			await testUtils.seedUsers([lookupUser()]);
			const header = basic('lookup_user', PASSWORD);
			const resolved = (await authenticate(header)).user;
			const cached = (await authenticate(header)).user;
			assert.strictEqual(user.isCurrentUser(resolved), true);
			await databases.system.hdb_user.put(lookupUser({ role: 'lookup_role' }));
			assert.strictEqual(user.isCurrentUser(resolved), false, 'the clone made on a cache miss');
			assert.strictEqual(user.isCurrentUser(cached), false, 'the clone made on a cache hit');
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

		it('checks a later login’s view of a memoized user against its own lookup, unless the record its first lookup read was dropped', async () => {
			await testUtils.seedUsers([lookupUser({ username: 'lookup_shared' })]);
			const shared = structuredClone(user.getUserWithRole('lookup_shared'));
			const getUser = server.getUser;
			server.getUser = async () => shared;
			try {
				await user.getTrackedUser('lookup_shared', 'token');
				await databases.system.hdb_user.put(lookupUser({ username: 'lookup_shared', role: 'lookup_role' }));
				const updated = (await authenticate(basic('lookup_shared', 'token'))).user;
				assert.notStrictEqual(updated, shared);
				assert.strictEqual(user.isCurrentUser(updated), true, 'the view is checked against what its login read');
				assert.strictEqual(user.isCurrentUser(shared), false, 'the user keeps what its first login read');

				await databases.system.hdb_user.delete('lookup_shared');
				const droppedLogin = await authenticate(basic('lookup_shared', 'token'));
				assert.strictEqual(
					droppedLogin.status,
					401,
					'the Basic login is refused once the record its first login read was dropped'
				);
				assert.strictEqual(droppedLogin.user, undefined);
				const droppedView = user.cloneUserView(
					shared,
					user.trackUserRecords(shared, user.userRecordVersions('lookup_shared'))
				);
				assert.strictEqual(user.isCurrentUser(droppedView), false, 'the record its first login read was dropped');
				assert.strictEqual(user.isRecordlessPrincipal(droppedView), false);
				assert.strictEqual(user.isRecordlessPrincipal(shared), false);
			} finally {
				server.getUser = getUser;
			}
		});

		it('refuses a Basic login whose view is stale after drop_user or repeated mid-lookup writes, re-resolves a single race, and defers without setting request.user on app routes', async () => {
			await testUtils.seedUsers([
				lookupUser({ username: 'lookup_app_dropped' }),
				lookupUser({ username: 'lookup_roleless_dropped' }),
				lookupUser({ username: 'lookup_midflight' }),
				lookupUser({ username: 'lookup_midflight_persistent' }),
			]);
			const shared = structuredClone(user.getUserWithRole('lookup_app_dropped'));
			const roleless = { username: 'lookup_roleless_dropped' };
			const getUser = server.getUser;
			let calls = 0;
			let transientMidflightCalls = 0;
			let persistentMidflightCalls = 0;
			server.getUser = async (username) => {
				calls++;
				if (username === 'lookup_roleless_dropped') return roleless;
				if (username === 'lookup_midflight') {
					transientMidflightCalls++;
					if (transientMidflightCalls === 1) {
						await databases.system.hdb_role.put({
							id: 'lookup_role',
							role: 'lookup_role',
							permission: { super_user: true },
						});
					}
					return structuredClone(user.getUserWithRole('lookup_midflight'));
				}
				if (username === 'lookup_midflight_persistent') {
					persistentMidflightCalls++;
					const copy = structuredClone(user.getUserWithRole('lookup_midflight_persistent'));
					await databases.system.hdb_role.put({
						id: 'lookup_role',
						role: 'lookup_role',
						permission: { super_user: persistentMidflightCalls % 2 === 0 },
					});
					return copy;
				}
				return shared;
			};
			try {
				const header = basic('lookup_app_dropped', 'token');
				assert.strictEqual((await authenticate(header)).status, 200);
				assert.strictEqual((await authenticate(basic('lookup_roleless_dropped', 'token'))).status, 200);
				await databases.system.hdb_user.delete('lookup_app_dropped');
				await databases.system.hdb_user.delete('lookup_roleless_dropped');

				let downstreamUser = 'not-run';
				let deferred;
				const appResponse = await authentication(
					{
						headers: { asObject: { authorization: header, host: 'localhost' } },
						method: 'GET',
						pathname: '/app-catch-all',
						ip: '10.0.0.1',
						isOperationsServer: false,
					},
					async (request) => {
						downstreamUser = request.user;
						deferred = getDeferredCredentialRejection(request);
						return { status: 200, headers: new Headers(), body: {} };
					}
				);
				assert.strictEqual(appResponse.status, 200, 'deferred rejection lets an unowned app route run');
				assert.strictEqual(downstreamUser, undefined, 'dropped principal must not leak onto request.user');
				assert.strictEqual(deferred?.strategy, 'Basic');
				assert.strictEqual(deferred?.status, 401);
				assert.strictEqual(deferred?.message, 'Login failed');

				const callsBeforeRepeat = calls;
				assert.strictEqual((await authenticate(header)).status, 401, 'rejected view was not cached');
				assert.strictEqual(calls, callsBeforeRepeat + 1);
				assert.strictEqual(
					(await authenticate(basic('lookup_roleless_dropped', 'token'))).status,
					401,
					'a role-less memoized object is also checked against its lookup provenance'
				);
				const transientResult = await authenticate(basic('lookup_midflight', 'token'));
				assert.strictEqual(transientResult.status, 200, 'a single concurrent write during getUser re-resolves once');
				assert.strictEqual(transientMidflightCalls, 2);
				assert.strictEqual(transientResult.user.role.permission.super_user, true);
				assert.strictEqual(
					(await authenticate(basic('lookup_midflight_persistent', 'token'))).status,
					401,
					'a view that stays stale after the retry is refused'
				);
				assert.strictEqual(persistentMidflightCalls, 2);
			} finally {
				server.getUser = getUser;
			}
		});

		it('admits a principal returned under another name whose own name has a tombstone, unless its first lookup read a live record', async () => {
			await testUtils.seedUsers([
				lookupUser({ username: 'lookup_sso_tombstone' }),
				lookupUser({ username: 'lookup_alias_live' }),
			]);
			await databases.system.hdb_user.delete('lookup_sso_tombstone');
			const memoizedSso = { username: 'lookup_sso_tombstone', role: { role: 'component_role', permission: {} } };
			const memoizedLive = { username: 'lookup_alias_live', role: { role: 'component_role', permission: {} } };
			let memoizedCreatedMidflight;
			const getUser = server.getUser;
			let aliasCalls = 0;
			let createdMidflightCalls = 0;
			server.getUser = async (username) => {
				if (username === 'lookup_sso_fresh_login') {
					return { username: 'lookup_sso_tombstone', role: { role: 'component_role', permission: {} } };
				}
				if (username === 'lookup_sso_memo_login') return memoizedSso;
				if (username === 'lookup_created_midflight') {
					createdMidflightCalls++;
					if (createdMidflightCalls === 1) {
						await databases.system.hdb_user.put(lookupUser({ username: 'lookup_created_midflight' }));
						memoizedCreatedMidflight = structuredClone(user.getUserWithRole('lookup_created_midflight'));
					}
					return memoizedCreatedMidflight;
				}
				aliasCalls++;
				return memoizedLive;
			};
			try {
				const freshLogin = await authenticate(basic('lookup_sso_fresh_login', 'token'));
				assert.strictEqual(freshLogin.status, 200, 'an unread tombstone under the returned name does not refuse login');
				assert.strictEqual(user.isRecordlessPrincipal(freshLogin.user), false, 'subscriptions still recheck by name');
				assert.strictEqual(user.isCurrentUser(freshLogin.user), false, 'and the authorization cache still re-resolves');

				assert.strictEqual((await authenticate(basic('lookup_sso_memo_login', 'token'))).status, 200);
				assert.strictEqual((await authenticate(basic('lookup_sso_memo_login', 'token'))).status, 200);

				assert.strictEqual((await authenticate(basic('lookup_alias_login', 'token'))).status, 200);
				await databases.system.hdb_user.delete('lookup_alias_live');
				const aliasCallsBeforeDrop = aliasCalls;
				assert.strictEqual(
					(await authenticate(basic('lookup_alias_login', 'token'))).status,
					401,
					'a memoized alias whose first lookup read a live record is refused once that record is dropped'
				);
				assert.strictEqual(aliasCalls, aliasCallsBeforeDrop + 1, 'a dropped alias record skips the retry');

				const createdMidflight = await authenticate(basic('lookup_created_midflight', 'token'));
				assert.strictEqual(createdMidflight.status, 200, 'a record created mid-lookup retries once and succeeds');
				assert.strictEqual(createdMidflightCalls, 2);
				await databases.system.hdb_user.delete('lookup_created_midflight');
				assert.strictEqual(
					(await authenticate(basic('lookup_created_midflight', 'token'))).status,
					401,
					'the retry updated firsts to the live stamp, so dropping that record later is refused'
				);
			} finally {
				server.getUser = getUser;
			}
		});

		it('classes each login’s view of a memoized user by the name its record was checked against', async () => {
			const unbacked = { username: 'lookup_shared_unbacked', role: { role: 'component_role', permission: {} } };
			const getUser = server.getUser;
			server.getUser = async () => unbacked;
			try {
				await testUtils.seedUsers([lookupUser({ username: 'lookup_admitting' })]);
				const admitted = (await authenticate(basic('lookup_admitting', 'token'))).user;
				assert.strictEqual(admitted.username, 'lookup_shared_unbacked');
				assert.strictEqual(user.isRecordlessPrincipal(admitted), false, 'the login name’s record may have admitted it');
				const tokenView = (await authenticate(basic('lookup_token_only', 'token'))).user;
				assert.strictEqual(user.isRecordlessPrincipal(tokenView), true, 'no record admitted this one');

				await testUtils.seedUsers([
					lookupUser({ username: 'lookup_admitting' }),
					lookupUser({ username: 'lookup_shared_unbacked' }),
				]);
				const later = (await authenticate(basic('lookup_token_later', 'token'))).user;
				assert.strictEqual(user.isRecordlessPrincipal(later), true, 'a record created later is another principal’s');
				assert.strictEqual(user.isRecordlessPrincipal(unbacked), true);
			} finally {
				server.getUser = getUser;
			}
		});

		it('caches a component user for a name, or a login name, whose record was dropped before it logged in', async () => {
			await testUtils.seedUsers([lookupUser({ username: 'lookup_reused' })]);
			await databases.system.hdb_user.delete('lookup_reused');
			const getUser = server.getUser;
			let resolutions = 0;
			server.getUser = async (username) => {
				resolutions++;
				return { username, role: { role: 'component_role', permission: {} } };
			};
			try {
				const header = basic('lookup_reused', 'token');
				const view = (await authenticate(header)).user;
				await authenticate(header);
				assert.strictEqual(resolutions, 1, 'nothing changed while it resolved, so the cached view stays current');
				assert.strictEqual(user.isRecordlessPrincipal(view), false, 'its name had a record');

				await testUtils.seedUsers([lookupUser({ username: 'lookup_reused_login' })]);
				await databases.system.hdb_user.delete('lookup_reused_login');
				server.getUser = async () => {
					resolutions++;
					return { username: 'lookup_reused_subject', role: { role: 'component_role', permission: {} } };
				};
				const aliasHeader = basic('lookup_reused_login', 'token');
				await authenticate(aliasHeader);
				await authenticate(aliasHeader);
				assert.strictEqual(resolutions, 2, 'nor for a login name whose record was dropped before');
			} finally {
				server.getUser = getUser;
			}
		});

		it('keeps a memoized user’s own name recordless however many record-backed logins reach it', async () => {
			const unbacked = { username: 'lookup_many_subject', role: { role: 'component_role', permission: {} } };
			user.trackUserRecords(unbacked, user.userRecordVersions('lookup_many_token'));
			const logins = Array.from({ length: 70 }, (_, index) => lookupUser({ username: `lookup_many_${index}` }));
			await testUtils.seedUsers(logins);
			for (const login of logins) {
				assert.strictEqual(user.trackUserRecords(unbacked, user.userRecordVersions(login.username)).recordless, false);
			}
			assert.strictEqual(user.isRecordlessPrincipal(unbacked), true);
		});

		it('hands the request a recordless view of a component principal for a name with no record, cached or not', async () => {
			const getUser = server.getUser;
			server.getUser = async (username) => ({ username, role: { role: 'component_role', permission: {} } });
			try {
				const header = basic('component_only_user', 'token');
				assert.strictEqual(user.isRecordlessPrincipal((await authenticate(header)).user), true);
				assert.strictEqual(user.isRecordlessPrincipal((await authenticate(header)).user), true, 'from the cache');
			} finally {
				server.getUser = getUser;
			}
		});

		it('caches a component principal under another name on an unaudited hdb_user, which holders re-read by name', async () => {
			const userTable = databases.system.hdb_user;
			const audited = userTable.audit;
			const getUser = server.getUser;
			let resolved = 0;
			server.getUser = async () => {
				resolved++;
				return { username: 'component_renamed_subject', role: { role: 'component_role', permission: {} } };
			};
			userTable.audit = false;
			try {
				const header = basic('component_renamed_login', 'token');
				const first = (await authenticate(header)).user;
				assert.strictEqual(user.isRecordlessPrincipal(first), false);
				assert.strictEqual(user.hasRecordProvenance(first), false);
				assert.strictEqual((await authenticate(header)).user.username, 'component_renamed_subject');
				assert.strictEqual(resolved, 1, 'the second request is served from the cache');
			} finally {
				userTable.audit = audited;
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

		it('names the changed user and role records', async () => {
			const changes = [];
			user.onUserChange((change) => changes.push(change));
			await testUtils.seedUsers([lookupUser()]);
			changes.length = 0;
			await nextUserChange(() => databases.system.hdb_user.put(lookupUser({ role: 'lookup_role' })));
			await nextUserChange(() =>
				databases.system.hdb_role.put({ id: 'lookup_role', role: 'lookup_role', permission: {} })
			);
			assert.deepStrictEqual(
				changes.map((change) => change && { usernames: [...change.usernames], roleIds: [...change.roleIds] }),
				[
					{ usernames: ['lookup_user'], roleIds: [] },
					{ usernames: [], roleIds: ['lookup_role'] },
				]
			);
		});

		it('notifies an unknown change for a whole-table reload', async () => {
			const changes = [];
			user.onUserChange((change) => changes.push(change));
			await nextUserChange(() => databases.system.hdb_role.writeReloadMarker());
			assert.strictEqual(changes.at(-1), undefined);
		});

		it('re-subscribes after its subscription closes, and notifies an unknown change for the gap', async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			await waitFor(() => user.userChangeNotificationEpoch() !== 0, { message: 'notifications never certified' });
			const epoch = user.userChangeNotificationEpoch();
			const changes = [];
			user.onUserChange((change) => changes.push(change));
			user._userChangeSubscription('hdb_role').close(new Error('event failed to deliver'));
			assert.strictEqual(user.userChangeNotificationEpoch(), 0);
			// only the reopen's notification may satisfy the gap check below
			await waitFor(() => changes.includes(undefined), { message: 'the close was not notified' });
			changes.length = 0;

			await waitFor(() => user.userChangeNotificationEpoch() !== 0, { timeout: 5000, message: 'never re-subscribed' });
			assert.notStrictEqual(user.userChangeNotificationEpoch(), epoch);
			await waitFor(() => changes.includes(undefined), { message: 'the gap was not notified' });
			await nextUserChange(() =>
				databases.system.hdb_role.put({ id: 'lookup_role', role: 'lookup_role', permission: {} })
			);
			assert.deepStrictEqual([...changes.at(-1).roleIds], ['lookup_role'], 'the new subscription delivers');
		});

		it('certifies continuous delivery only where the storage engine can', async () => {
			await waitFor(() => user.userChangeNotificationEpoch() !== 0 || process.env.HARPER_STORAGE_ENGINE === 'lmdb');
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') assert.strictEqual(user.userChangeNotificationEpoch(), 0);
			else assert.ok(user.userChangeNotificationEpoch() > 0);
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
