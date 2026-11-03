'use strict';

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
const env = require('#src/utility/environment/environmentManager');
const { databases } = require('#src/resources/databases');
const roles = require('#src/security/role');
const user = require('#src/security/user');
const insert = require('#src/dataLayer/insert');
const logger = require('#src/utility/logging/harper_logger');

const ROLE = 'test_system_grant_boundary';
const system = {
	tables: { hdb_user: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] } },
};

describe('System role permission boundary', () => {
	before(async () => {
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();
		await require('#src/utility/mount_hdb').default(env.getHdbBasePath());
	});

	afterEach(async () => {
		logger.initLogSettings(true);
		await databases.system.hdb_role.delete(ROLE);
		await databases.system.hdb_role.delete(ROLE + '_rejected');
		await databases.system.hdb_user.delete(ROLE + '_first');
		await databases.system.hdb_user.delete(ROLE + '_second');
	});

	for (const operation of ['add_role', 'alter_role']) {
		it(`rejects permission.system through ${operation} without changing storage`, async () => {
			await roles.addRole({ operation: 'add_role', role: ROLE, id: ROLE, permission: { super_user: false } });
			await assert.rejects(
				roles[operation === 'add_role' ? 'addRole' : 'alterRole']({
					operation,
					role: operation === 'add_role' ? ROLE + '_rejected' : ROLE,
					id: operation === 'add_role' ? ROLE + '_rejected' : ROLE,
					permission: { super_user: false, system },
				}),
				(error) => error.statusCode === 400 && /system.*managed by Harper/.test(JSON.stringify(error.http_resp_msg))
			);
			assert.deepStrictEqual((await roles.getRoleByName(ROLE)).permission, { super_user: false });
			assert.strictEqual(await roles.getRoleByName(ROLE + '_rejected'), null);
		});
	}

	for (const read of ['listRoles', 'getRoleByName', 'userInfo', 'listUsers']) {
		it(`${read} normalizes legacy grants without changing storage and warns once`, async () => {
			await insert.insert({
				operation: 'insert',
				schema: 'system',
				table: 'hdb_role',
				records: [
					{ id: ROLE, role: ROLE, permission: { super_user: false, operations: ['describe_database'], system } },
				],
			});
			await insert.insert({
				operation: 'insert',
				schema: 'system',
				table: 'hdb_user',
				records: ['first', 'second'].map((suffix) => ({ username: ROLE + '_' + suffix, role: ROLE, active: true })),
			});
			const logs = [];
			logger.setMainLogger(logger.createLogger({ level: 'warn', writeToLog: (line) => logs.push(line) }));
			let reported;
			if (read === 'listUsers') {
				const users = await user.listUsers();
				assert.strictEqual(users.get(ROLE + '_first').role.permission.system.tables.hdb_user.read, false);
				assert.strictEqual(users.get(ROLE + '_second').role.permission.system.tables.hdb_user.read, false);
				reported = await roles.getRoleByName(ROLE);
			} else if (read === 'userInfo') {
				reported = (await user.userInfo({ hdb_user: { username: 'legacy', role: { id: ROLE } } })).role;
			} else if (read === 'listRoles') {
				reported = (await roles.listRoles()).find((role) => role.id === ROLE);
			} else reported = await roles.getRoleByName(ROLE);
			assert.strictEqual(reported.id, ROLE);
			assert.strictEqual(reported.role, ROLE);
			assert.deepStrictEqual(reported.permission, { super_user: false, operations: ['describe_database'] });
			const stored = await databases.system.hdb_role.get(ROLE);
			assert.ok(stored.permission.system, 'reads must not race a concurrent alter_role with a cleanup write');
			await roles.listRoles();
			await user.listUsers();
			const warnings = logs.filter((line) => line.includes(`role '${ROLE}'`) && line.includes('hdb_user'));
			assert.strictEqual(warnings.length, 1);
		});
	}

	it('replaces inline and stored impersonation system grants after downgrade', async () => {
		const { applyImpersonation } = require('#src/security/impersonation');
		await insert.insert({
			operation: 'insert',
			schema: 'system',
			table: 'hdb_role',
			records: [{ id: ROLE, role: ROLE, permission: { super_user: false, system } }],
		});
		const admin = { username: 'admin', active: true, role: { permission: { super_user: true } } };
		for (const payload of [
			{ role: { permission: { super_user: true, system: { ...system, describe: false } } } },
			{ role_name: ROLE },
		]) {
			const result = await applyImpersonation(admin, payload);
			assert.strictEqual(result.role.permission.super_user, false);
			assert.strictEqual(result.role.permission.system.describe, undefined);
			assert.strictEqual(result.role.permission.system.tables.hdb_user.read, false);
			assert.strictEqual(result.role.permission.system.tables.hdb_user.insert, false);
		}
		assert.strictEqual(system.tables.hdb_user.read, true);
	});
});
