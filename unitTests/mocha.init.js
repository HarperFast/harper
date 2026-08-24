/**
 * Mocha initialization hook - runs before any tests are loaded.
 * Sets up the test database path environment so modules that eagerly
 * initialize database connections (like security/auth.ts) don't fail
 * during module loading.
 *
 * Every database — including `system` — resolves inside the per-PID test
 * directory, so a unit run never opens an installed Harper root (whose
 * RocksDB LOCK is exclusive: borrowing it makes unit runs fail whenever a
 * running Harper or a leaked test process holds it). Suites that need the
 * system tables to exist seed them into the per-PID directory via
 * ensureSystemTables() in testUtils.js.
 *
 * The per-PID config file plus the ROOTPATH environment variable must be in
 * place BEFORE any Harper module loads: config resolution
 * (configUtils.getConfigFilePath) and the logger's file stream bind to
 * ROOTPATH at first initialization, so setting it late leaves the run
 * reading the installed root's config and appending to its hdb.log.
 * ROOTPATH stays exported for the whole run — worker threads a test spawns
 * and mid-run config/logger re-initializations must resolve the per-PID
 * root too. The few test files that specifically exercise boot-props-based
 * resolution (which a ROOTPATH env var shadows) clear the variable and the
 * noBootFile() memo for their own scope.
 *
 * storage.path is pinned to <pid dir>/database (the same layout the config
 * template yields, asserted absolutely so an inherited config can never
 * point the database scan anywhere else). `system` — and any ad-hoc
 * database a test creates — resolves under it, exactly like production.
 * Keep it distinct from the per-PID directory itself: the databases-config
 * scan in getDatabases() loads every RocksDB directory under a configured
 * path as that database, so databases placed next to data/dev/test/test2's
 * configured path would be aliased into them on any resetDatabases().
 */

const path = require('path');
const fs = require('fs-extra');

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

const UNIT_TEST_DIR = __dirname;
const ENV_DIR_NAME = 'envDir';
const ENV_DIR_PATH = path.join(UNIT_TEST_DIR, ENV_DIR_NAME);
const PID_DIR_PATH = path.join(ENV_DIR_PATH, process.pid.toString());

if (!fs.existsSync(PID_DIR_PATH)) {
	fs.mkdirSync(PID_DIR_PATH, { recursive: true });
}
// config validation requires the configured paths to exist, as after an install
for (const dir of ['database', 'log', 'components', 'keys']) {
	fs.mkdirSync(path.join(PID_DIR_PATH, dir), { recursive: true });
}
const configFilePath = path.join(PID_DIR_PATH, 'harper-config.yaml');
if (!fs.existsSync(configFilePath)) {
	const YAML = require('yaml');
	const configDoc = YAML.parseDocument(
		fs.readFileSync(path.join(UNIT_TEST_DIR, '../static/defaultConfig.yaml'), 'utf8')
	);
	configDoc.setIn(['rootPath'], PID_DIR_PATH);
	// resolve the path fields the installer's config validation would otherwise fill in
	configDoc.setIn(['componentsRoot'], 'components');
	configDoc.setIn(['logging', 'root'], 'log');
	configDoc.setIn(['logging', 'rotation', 'path'], 'log');
	configDoc.setIn(['storage', 'path'], 'database');
	fs.writeFileSync(configFilePath, configDoc.toString());
}
process.env.ROOTPATH = PID_DIR_PATH;
// raw env vars outrank every configured path in getDatabases()/resolveDatabaseStorageRoot,
// so an ambient STORAGE_PATH or SCHEMAS_DATA_PATH from the shell would reopen the
// installed root despite everything above
delete process.env.STORAGE_PATH;
delete process.env.SCHEMAS_DATA_PATH;

// Only now is it safe to load Harper modules
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');

env.initSync();

env.setProperty(terms.HDB_SETTINGS_NAMES.HDB_ROOT_KEY, PID_DIR_PATH);
env.setProperty(terms.CONFIG_PARAMS.STORAGE_PATH, path.join(PID_DIR_PATH, 'database'));

const databasePaths = {
	data: { path: PID_DIR_PATH },
	dev: { path: PID_DIR_PATH },
	test: { path: PID_DIR_PATH },
	test2: { path: PID_DIR_PATH },
};
env.setProperty(terms.CONFIG_PARAMS.DATABASES, databasePaths);
