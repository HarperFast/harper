/**
 * Mocha initialization hook - runs before any tests are loaded.
 * Sets up the test database path environment so modules that eagerly
 * initialize database connections (like security/auth.ts) don't fail
 * during module loading.
 */

const path = require('path');
const fs = require('fs-extra');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');

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
