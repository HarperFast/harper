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

/**
 * Fail a mocha run that dies mid-flight instead of letting it look like a pass.
 *
 * A run can stop advancing without anything failing: a reporter write that throws inside the
 * runner's callback chain, or a hook that never calls back. `timeout: 0` in .mocharc.json means
 * no test ever times out, so nothing marks the stalled test failed — the event loop simply drains
 * and the process exits 0 having printed no epilogue and no failure. Every runner reads that as
 * success. harper_logger.test.js did exactly this to any `dot`/`tap` run before it was fixed.
 *
 * Root hooks bracket the run, so "started but never finished" is the signal. Report it on fd 2
 * with writeSync, since an unwritable stdout is one of the ways to get here.
 */
let runStarted = false;
let runFinished = false;

module.exports.mochaHooks = {
	beforeAll() {
		runStarted = true;
	},
	afterAll() {
		runFinished = true;
	},
};

process.on('exit', (code) => {
	if (!runStarted || runFinished || code !== 0) return;
	fs.writeSync(
		2,
		'\n*** mocha exited 0 without finishing its run: no epilogue was printed and no test failed. ***\n' +
			'*** The run stalled or was aborted part-way through; treat this as a failure, not a pass. ***\n'
	);
	process.exitCode = 1;
});

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
