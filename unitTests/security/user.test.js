'use strict';

process.on('unhandledRejection', (reason, promise) => {
	console.log('Unhandled Rejection at:', promise, 'reason:', reason);
	throw new Error(`Unhandled Rejection at:', ${promise}, 'reason:', ${reason}`);
});

require('../testUtils.js');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised').default;
chai.use(chaiAsPromised);
const { expect } = chai;
const env_mgr = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { databases, table } = require('#src/resources/databases');
const password = require('#src/utility/password');
let user = require('#src/security/user');

const TEST_PASSWORD = 'test1234!';

async function dropTestUsers() {
	await user.dropUser({ username: 'test_user' }).catch(() => {});
	await user.dropUser({ username: 'test_user_undefined' }).catch(() => {});
	await user.dropUser({ username: 'test_user_md5' }).catch(() => {});
	await user.dropUser({ username: 'test_user_sha256' }).catch(() => {});
	await user.dropUser({ username: 'test_user_argon2id' }).catch(() => {});
}

async function addTestUser() {
	await user.addUser({
		operation: 'add_user',
		role: 'super_user',
		username: 'test_user',
		password: TEST_PASSWORD,
		active: true,
	});
}

function setHashFunction(hashFunction) {
	delete require.cache[require.resolve('#src/security/user')];
	delete require.cache[require.resolve('#src/utility/password')];
	env_mgr.setProperty(CONFIG_PARAMS.AUTHENTICATION_HASHFUNCTION, hashFunction);
	require('#src/utility/password');
	user = require('#src/security/user');
}

describe('user.ts Unit Tests', () => {
	before(async () => {
		const testUtils = require('../testUtils.js');
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();
		const mountHdb = require('#src/utility/mount_hdb').default;
		const { addRole } = require('#src/security/role');
		await mountHdb(env_mgr.getHdbBasePath());
		try {
			await addRole({
				role: 'super_user',
				id: 'super_user',
				permission: {
					super_user: true,
				},
			});
		} catch {}
		await user.setUsersWithRolesCache();
	});

	afterEach(async () => {
		await dropTestUsers();
	});

	describe('Test addUser', () => {
		it('should add four new users each with the correct hash function', async () => {
			const addUserObj = {
				operation: 'add_user',
				role: 'super_user',
				active: true,
			};

			setHashFunction(undefined);
			addUserObj.username = 'test_user_undefined';
			addUserObj.password = 'pass-undefined';
			await user.addUser(addUserObj);

			setHashFunction('md5');
			addUserObj.username = 'test_user_md5';
			addUserObj.password = 'pass-md5';
			await user.addUser(addUserObj);

			setHashFunction('sha256');
			addUserObj.username = 'test_user_sha256';
			addUserObj.password = 'pass-sha256';
			await user.addUser(addUserObj);

			setHashFunction('argon2id');
			addUserObj.username = 'test_user_argon2id';
			addUserObj.password = 'pass-argon2id';
			await user.addUser(addUserObj);

			const users = await user.listUsers();
			expect(users.get('test_user_undefined').password.length).to.be.greaterThan(10);
			expect(users.get('test_user_md5').password.length).to.be.greaterThan(10);
			expect(users.get('test_user_sha256').password.length).to.be.greaterThan(10);
			expect(users.get('test_user_argon2id').password.length).to.be.greaterThan(10);
		});

		it('should throw an error if role is not found', async () => {
			const addUserObj = {
				operation: 'add_user',
				role: 'non-existent-role',
				username: 'test_user',
				password: TEST_PASSWORD,
				active: true,
			};

			await expect(user.addUser(addUserObj)).to.be.rejectedWith('non-existent-role role not found');
		});
	});

	describe('Test alterUser', () => {
		it('should alter a user password successfully', async () => {
			await addTestUser();
			const alterUserObj = {
				operation: 'alter_user',
				username: 'test_user',
				password: 'new-password',
			};

			await user.alterUser(alterUserObj);
			const findUser = await user.userInfo({ hdb_user: { username: 'test_user' } });
			expect(findUser.username).to.equal('test_user');
		});

		it('should throw an error if validation fails', async () => {
			const alterUserObj = {
				operation: 'alter_user',
				username: 'test_user',
			};

			await expect(user.alterUser(alterUserObj)).to.be.rejected;
		});
	});

	describe('Test dropUser', () => {
		it('should drop a user successfully', async () => {
			await addTestUser();
			await user.dropUser({ username: 'test_user' });
			const users = await user.listUsers();
			expect(users.has('test_user')).to.be.false;
		});

		it('should throw an error if user does not exist', async () => {
			await expect(user.dropUser({ username: 'non-existent-user' })).to.be.rejectedWith(
				'User non-existent-user does not exist'
			);
		});
	});

	describe('Test findAndValidateUser', () => {
		it('should find and validate a user successfully', async () => {
			await addTestUser();
			const result = await user.findAndValidateUser('test_user', TEST_PASSWORD);
			expect(result.username).to.equal('test_user');
		});

		it('should throw an error if user is inactive', async () => {
			await addTestUser();
			await user.alterUser({ operation: 'alter_user', username: 'test_user', active: false });
			await expect(user.findAndValidateUser('test_user', TEST_PASSWORD)).to.be.rejectedWith('User is inactive');
		});

		it('should validate a user with no hash_function value', async () => {
			await addTestUser();
			// Manually remove hash_function from the database record and use MD5 hash
			const hashedPassword = await password.hash(TEST_PASSWORD, 'md5');
			await databases.system.hdb_user.put({
				username: 'test_user',
				password: hashedPassword,
				role: 'super_user',
				active: true,
			});
			await user.setUsersWithRolesCache();
			const result = await user.findAndValidateUser('test_user', TEST_PASSWORD);
			expect(result.username).to.equal('test_user');
		});
	});

	describe('Test userInfo, listUsersExternal, getSuperUser and getClusterUser', () => {
		it('should return user info', async () => {
			const result = await user.userInfo({
				hdb_user: {
					username: 'test_user',
					role: { id: 'super_user' },
					password: '123Abc',
					refresh_token: '34124sdfas',
					hash: '83b3dj3',
				},
			});
			expect(result.username).to.equal('test_user');
		});

		it('should return a list of users', async () => {
			await addTestUser();
			const result = await user.listUsersExternal();
			expect(result.some((u) => u.username === 'test_user')).to.be.true;
		});

		it('should return the super user', async () => {
			await addTestUser();
			const result = await user.getSuperUser();
			expect(result.role.role).to.equal('super_user');
			await dropTestUsers();
		});
	});

	describe('Test system table permissions', () => {
		const COMPONENT_TABLE = 'hdb_test_component_state';
		const READ_ONLY_ROLE = 'test_read_only_role';
		// Deliberately not the names dropTestUsers() clears — these users have to outlive the
		// afterEach so every assertion reads the same cache that was built before COMPONENT_TABLE.
		const SUPER_USER = 'test_system_perms_su';
		const READ_ONLY_USER = 'test_system_perms_read_only';
		let componentTable;

		before(async () => {
			const { addRole } = require('#src/security/role');
			try {
				await addRole({
					role: READ_ONLY_ROLE,
					id: READ_ONLY_ROLE,
					permission: { super_user: false },
				});
			} catch {}
			await user.addUser({
				operation: 'add_user',
				role: READ_ONLY_ROLE,
				username: READ_ONLY_USER,
				password: TEST_PASSWORD,
				active: true,
			});
			await user.addUser({
				operation: 'add_user',
				role: 'super_user',
				username: SUPER_USER,
				password: TEST_PASSWORD,
				active: true,
			});
			expect(Object.keys(require('../../json/systemSchema.json'))).to.not.include(COMPONENT_TABLE);
			// Build the cache BEFORE the table exists — a component creating a system table at
			// runtime is exactly the case the old snapshot could not see (harper#2120).
			await user.setUsersWithRolesCache();
			componentTable = table({
				database: 'system',
				table: COMPONENT_TABLE,
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
		});

		after(async () => {
			await user.dropUser({ username: READ_ONLY_USER }).catch(() => {});
			await user.dropUser({ username: SUPER_USER }).catch(() => {});
			// The unit suite shares an hdb root, so leaving this behind would let it accumulate in
			// the shared system database and show up in any later test that enumerates one.
			await componentTable?.dropTable().catch(() => {});
		});

		async function cachedRolePermissions(username) {
			const resolved = await user.findAndValidateUser(username, TEST_PASSWORD);
			return resolved.role.permission;
		}

		it('should grant a super_user read on a system table created after the cache was built', async () => {
			const permission = await cachedRolePermissions(SUPER_USER);
			expect(permission.system.tables[COMPONENT_TABLE]).to.deep.equal({
				read: true,
				insert: false,
				update: false,
				delete: false,
				attribute_permissions: [],
			});
		});

		it('should not grant a non-super_user read on a component-created system table', async () => {
			const permission = await cachedRolePermissions(READ_ONLY_USER);
			expect(permission.system.tables[COMPONENT_TABLE].read).to.be.false;
		});

		it('should keep writes denied on a component-created system table for a super_user', async () => {
			const permission = await cachedRolePermissions(SUPER_USER);
			const tablePermissions = permission.system.tables[COMPONENT_TABLE];
			expect(tablePermissions.insert).to.be.false;
			expect(tablePermissions.update).to.be.false;
			expect(tablePermissions.delete).to.be.false;
		});

		it('should still resolve install-time system tables', async () => {
			const permission = await cachedRolePermissions(SUPER_USER);
			expect(permission.system.tables.hdb_user.read).to.be.true;
			expect(permission.system.tables.hdb_role.read).to.be.true;
		});

		it('should return undefined for a table that is not in the system database', async () => {
			const permission = await cachedRolePermissions(SUPER_USER);
			expect(permission.system.tables.hdb_not_a_real_table).to.be.undefined;
			expect('hdb_not_a_real_table' in permission.system.tables).to.be.false;
		});

		it('should be a plain cloneable object, since operations are forwarded to worker threads', async () => {
			// A Proxy here fails the whole operation with DataCloneError: forwarding structured-clones
			// the request, permissions included (server/operations forwarding, harper#2120 CI).
			const permission = await cachedRolePermissions(SUPER_USER);
			const { tables } = permission.system;
			expect(() => structuredClone(tables)).to.not.throw();
			expect(structuredClone(tables)[COMPONENT_TABLE].read).to.be.true;
			expect(() => `${tables}`).to.not.throw();
		});

		it('should reach identities holding an earlier reference to the map', async () => {
			// auth.ts serves warmed authorization entries and getSuperUser() hands back cached roles;
			// neither re-reads the map, so replacing it instead of updating in place would strand them
			// on the stale copy and reproduce the original 403.
			const { databaseEventsEmitter } = require('#src/resources/databases');
			const held = (await cachedRolePermissions(SUPER_USER)).system.tables;
			const LATE_TABLE = 'hdb_test_late_component';
			const late = table({
				database: 'system',
				table: LATE_TABLE,
				attributes: [{ name: 'id', isPrimaryKey: true }],
			});
			try {
				expect(held[LATE_TABLE]).to.not.be.undefined;
				expect(held[LATE_TABLE].read).to.be.true;
			} finally {
				await late?.dropTable().catch(() => {});
				delete databases.system[LATE_TABLE];
				databaseEventsEmitter.emit('dropTable', LATE_TABLE, 'system');
			}
		});

		it('should not let one role mutate the permissions every other role reads', async () => {
			// The map is shared per read permission so warmed identities stay fresh; that sharing is
			// only safe while the entries cannot be written through.
			const permission = await cachedRolePermissions(SUPER_USER);
			const entry = permission.system.tables[COMPONENT_TABLE];
			expect(Object.isFrozen(entry)).to.be.true;
			expect(() => {
				'use strict';
				entry.insert = true;
			}).to.throw();
			const other = await cachedRolePermissions(READ_ONLY_USER);
			expect(other.system.tables[COMPONENT_TABLE].insert).to.be.false;
			expect(permission.system.tables[COMPONENT_TABLE].insert).to.be.false;
		});

		it('should hold a table named __proto__ as an own property', async () => {
			// A plain assignment would hit the inherited setter, so the table would vanish from
			// Object.keys and from a structured clone while still appearing to have been granted.
			const { databaseEventsEmitter } = require('#src/resources/databases');
			databases.system.__proto__ = { primaryKey: 'id' };
			databaseEventsEmitter.emit('updateTable', { databaseName: 'system' });
			try {
				const { tables } = (await cachedRolePermissions(SUPER_USER)).system;
				expect(Object.hasOwn(tables, '__proto__')).to.be.true;
				expect(Object.keys(tables)).to.include('__proto__');
				expect(tables['__proto__'].read).to.be.true;
				expect(structuredClone(tables)['__proto__'].read).to.be.true;
			} finally {
				delete databases.system['__proto__'];
				databaseEventsEmitter.emit('dropTable', '__proto__', 'system');
			}
		});

		it('should stop resolving a table once it leaves the registry', async () => {
			const { databaseEventsEmitter } = require('#src/resources/databases');
			const registered = databases.system[COMPONENT_TABLE];
			delete databases.system[COMPONENT_TABLE];
			databaseEventsEmitter.emit('dropTable', COMPONENT_TABLE, 'system');
			try {
				const permission = await cachedRolePermissions(SUPER_USER);
				expect(permission.system.tables[COMPONENT_TABLE]).to.be.undefined;
			} finally {
				databases.system[COMPONENT_TABLE] = registered;
				databaseEventsEmitter.emit('updateTable', registered);
			}
		});

		it('should enumerate the component-created table alongside the install-time ones', async () => {
			const permission = await cachedRolePermissions(SUPER_USER);
			const systemSchema = require('../../json/systemSchema.json');
			const enumerated = Object.keys(permission.system.tables);
			for (const installTable of Object.keys(systemSchema)) {
				expect(enumerated).to.include(installTable);
			}
			expect(enumerated).to.include(COMPONENT_TABLE);
		});

		it('should carry the component-created table through a JSON round trip', async () => {
			const permission = await cachedRolePermissions(SUPER_USER);
			const roundTripped = JSON.parse(JSON.stringify(permission.system.tables));
			expect(roundTripped[COMPONENT_TABLE].read).to.be.true;
		});

		it('should not honor a system-table grant the role declared for itself', async () => {
			// add_role accepts a `system` block, and the old merge-in-place loop only overwrote the
			// systemSchema names — so a non-super_user role could declare read on a component-created
			// system table (hdb_session, say) and keep it. Wholesale replacement closes that.
			const { addRole } = require('#src/security/role');
			const SELF_GRANT_ROLE = 'test_self_granted_system_role';
			const SELF_GRANT_USER = 'test_self_granted_system_user';
			try {
				await addRole({
					role: SELF_GRANT_ROLE,
					id: SELF_GRANT_ROLE,
					permission: {
						super_user: false,
						system: {
							tables: {
								[COMPONENT_TABLE]: {
									read: true,
									insert: false,
									update: false,
									delete: false,
									attribute_permissions: [],
								},
							},
						},
					},
				});
			} catch {}
			await user.addUser({
				operation: 'add_user',
				role: SELF_GRANT_ROLE,
				username: SELF_GRANT_USER,
				password: TEST_PASSWORD,
				active: true,
			});
			await user.setUsersWithRolesCache();
			try {
				const permission = await cachedRolePermissions(SELF_GRANT_USER);
				expect(permission.system.tables[COMPONENT_TABLE].read).to.be.false;
			} finally {
				await user.dropUser({ username: SELF_GRANT_USER }).catch(() => {});
			}
		});

		it('should expose the shape hasPermissions reads, keyed by table name', async () => {
			// hasPermissions itself is unreachable from a CJS test: operation_authorization.ts:406
			// reassigns module.exports and drops it from the require surface. The end-to-end check
			// lives in integrationTests/security/system-table-authz.test.ts.
			const permission = await cachedRolePermissions(SUPER_USER);
			const { tables } = permission.system;
			expect(tables[COMPONENT_TABLE]).to.have.property('read', true);
			expect(tables[COMPONENT_TABLE]).to.have.property('attribute_permissions').that.is.an('array');
		});
	});
});
