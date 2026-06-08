/**
 * Mocha initialization hook - runs before any tests are loaded.
 * Sets up the test database path environment so modules that eagerly
 * initialize database connections (like security/auth.ts) don't fail
 * during module loading.
 *
 * IMPORTANT: This pre-seeds DATABASES to an empty per-PID test directory,
 * which is appropriate for unit tests that mock out the DB layer. The
 * apiTests suite (`test:unit:apitests`) instead boots a real Harper server
 * and relies on the actual installed system database (with hdb_role,
 * hdb_user, etc.) being discoverable by `getDatabases()` in
 * `apiTests/setupTestApp.mjs` before its own `setupTestDBPath()` runs. If
 * we override DATABASES here, that preservation step has nothing to
 * preserve and `setUsersWithRolesCache()` fails with "Table hdb_role not
 * found". So skip the override when mocha was invoked against apiTests.
 */

const path = require('path');
const fs = require('fs-extra');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');

const isApiTestRun = process.argv.some((arg) => typeof arg === 'string' && arg.includes('apiTests'));

if (!isApiTestRun) {
	const UNIT_TEST_DIR = __dirname;
	const ENV_DIR_NAME = 'envDir';
	const ENV_DIR_PATH = path.join(UNIT_TEST_DIR, ENV_DIR_NAME);
	const PID_DIR_PATH = path.join(ENV_DIR_PATH, process.pid.toString());

	// Initialize environment manager
	env.initSync();

	// Set up the base test database path
	if (!fs.existsSync(PID_DIR_PATH)) {
		fs.mkdirSync(PID_DIR_PATH, { recursive: true });
	}
	env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, PID_DIR_PATH);

	// Set up database paths
	const databasePaths = {
		data: { path: PID_DIR_PATH },
		dev: { path: PID_DIR_PATH },
		test: { path: PID_DIR_PATH },
		test2: { path: PID_DIR_PATH },
	};
	env.setProperty(terms.CONFIG_PARAMS.DATABASES, databasePaths);
}
