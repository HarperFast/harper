const assert = require('node:assert');
const testUtils = require('../testUtils.js');
const env = require('#src/utility/environment/environmentManager');
const { databases } = require('#src/resources/databases');

const ADDED = 'refresh_added_user';
const REVOKED = 'refresh_revoked_user';
const DELETED = 'refresh_deleted_user';

describe('setUsersWithRolesCache under concurrent refreshes', function () {
	let user;

	before(async () => {
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();
		const mountHdb = require('#src/utility/mount_hdb').default;
		await mountHdb(env.getHdbBasePath());
		try {
			await require('#src/security/role').addRole({
				role: 'super_user',
				id: 'super_user',
				permission: { super_user: true },
			});
		} catch {}
		user = require('#src/security/user');
	});

	after(async () => {
		for (const username of [ADDED, REVOKED, DELETED]) await databases.system.hdb_user.delete(username);
		await user.setUsersWithRolesCache();
	});

	it('serves 50 concurrent callers from at most two scans that see writes and revocations made before the calls', async () => {
		await databases.system.hdb_user.put({ username: REVOKED, role: 'super_user', active: true });
		await databases.system.hdb_user.put({ username: DELETED, role: 'super_user', active: true });
		await user.setUsersWithRolesCache();

		const inFlight = user.setUsersWithRolesCache();
		await databases.system.hdb_user.put({ username: ADDED, role: 'super_user', active: true });
		await databases.system.hdb_user.put({ username: REVOKED, role: 'super_user', active: false });
		await databases.system.hdb_user.delete(DELETED);
		const caches = await Promise.all(
			Array.from({ length: 50 }, () => user.setUsersWithRolesCache().then(() => user.getUsersWithRolesCache()))
		);
		await inFlight;

		assert.ok(new Set(caches).size <= 2, `50 callers were served by ${new Set(caches).size} scans`);
		for (const cache of caches) {
			assert.ok(cache.has(ADDED));
			assert.strictEqual(cache.get(REVOKED).active, false);
			assert.ok(!cache.has(DELETED));
		}
		await assert.rejects(user.findAndValidateUser(REVOKED, 'any password'), /inactive/);
		await assert.rejects(user.findAndValidateUser(DELETED, 'any password'), { statusCode: 401 });
	});
});
