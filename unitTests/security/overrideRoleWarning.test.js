'use strict';

const assert = require('node:assert');
const testUtils = require('../testUtils.js');
const harperLogger = require('#js/utility/logging/harper_logger');
const password = require('#src/utility/password');
const { databases } = require('#src/resources/databases');
const { server } = require('#src/server/Server');
const { Headers } = require('#src/server/serverHelpers/Headers');
const user = require('#src/security/user');
const { authentication } = require('#src/security/auth');

const PASSWORD = 'override-password';

function storedUser(username) {
	return {
		username,
		active: true,
		password: password.hash(PASSWORD, password.HASH_FUNCTION.SHA256),
		hash_function: password.HASH_FUNCTION.SHA256,
		role: { id: 'stored_role', role: 'stored_role', permission: { super_user: false } },
	};
}

const overrideRole = (id) => ({ id, role: id, permission: { super_user: false } });

async function basicLogin(username) {
	let authenticated;
	const response = await authentication(
		{
			headers: {
				asObject: {
					authorization: 'Basic ' + Buffer.from(`${username}:${PASSWORD}`).toString('base64'),
					host: 'localhost',
				},
			},
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

describe('a server.getUser override that returns a stored name with another role', function () {
	let warnings;
	let originalWarn;
	let originalGetUser;

	before(async () => {
		testUtils.preTestPrep();
		testUtils.setupTestDBPath();
		await testUtils.ensureSystemTables();
	});

	beforeEach(() => {
		warnings = [];
		originalWarn = harperLogger.warn;
		// only this check's lines: anything else on the thread may warn meanwhile
		harperLogger.warn = (...args) => {
			const line = args.join(' ');
			if (line.startsWith("server.getUser returned user 'override_")) warnings.push(line);
		};
		originalGetUser = server.getUser;
	});

	afterEach(async () => {
		harperLogger.warn = originalWarn;
		server.getUser = originalGetUser;
		await testUtils.seedUsers();
	});

	it('warns once per name on an HTTP Basic login, naming both roles', async () => {
		await testUtils.seedUsers([storedUser('override_basic')]);
		let lookups = 0;
		server.getUser = async (username) => {
			lookups++;
			return { username, active: true, role: overrideRole('override_role') };
		};
		assert.strictEqual((await basicLogin('override_basic')).status, 200);
		assert.strictEqual(warnings.length, 1);
		assert.match(warnings[0], /'override_basic' with role 'override_role'.*record has role 'stored_role'/);
		await databases.system.hdb_user.put({ ...storedUser('override_basic'), role: 'stored_role', active: true });
		assert.strictEqual((await basicLogin('override_basic')).status, 200);
		assert.strictEqual(lookups, 2, 'the record change evicted the cached login');
		assert.strictEqual(warnings.length, 1, 'the name has warned');
	});

	it('warns for the built-in lookup’s view with its role swapped', async () => {
		await testUtils.seedUsers([storedUser('override_wrapped')]);
		server.getUser = async (username) => ({ ...user.getUserWithRole(username), role: overrideRole('swapped_role') });
		await user.getTrackedUser('override_wrapped', 'token');
		assert.strictEqual(warnings.length, 1);
		assert.match(warnings[0], /'override_wrapped' with role 'swapped_role'/);
	});

	it('warns for a stored name returned for another login name, by the returned name’s record', async () => {
		await testUtils.seedUsers([storedUser('override_login'), storedUser('override_subject')]);
		server.getUser = async () => ({ username: 'override_subject', role: overrideRole('override_role') });
		await user.getTrackedUser('override_login', 'token');
		assert.strictEqual(warnings.length, 1);
		assert.match(warnings[0], /'override_subject' with role 'override_role'.*record has role 'stored_role'/);
	});

	it('counts only this check’s warnings for its own names', () => {
		harperLogger.warn('an unrelated warning');
		harperLogger.warn("server.getUser returned user 'someone_else' with role 'a'");
		assert.deepStrictEqual(warnings, []);
	});

	it('does not warn for a copy of the stored user, a name with no record, or a memoized recordless user', async () => {
		await testUtils.seedUsers([storedUser('override_copy')]);
		server.getUser = async (username) => structuredClone(user.getUserWithRole(username));
		await user.getTrackedUser('override_copy', 'token');

		server.getUser = async (username) => ({ username, role: overrideRole('override_role') });
		await user.getTrackedUser('override_unbacked', 'token');

		const memoized = { username: 'override_memoized', role: overrideRole('override_role') };
		server.getUser = async () => memoized;
		await user.getTrackedUser('override_memoized', 'token');
		await testUtils.seedUsers([storedUser('override_copy'), storedUser('override_memoized')]);
		await user.getTrackedUser('override_memoized', 'token');
		assert.strictEqual(user.isRecordlessPrincipal(memoized), true, 'a record created later is another principal’s');

		assert.deepStrictEqual(warnings, []);
	});
});
