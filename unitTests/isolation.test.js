'use strict';

// Regression coverage for the per-PID root contract mocha.init.js establishes (see its
// header comment): a unit run must never resolve a database, config, or log path into an
// installed Harper root — including via ambient STORAGE_PATH/SCHEMAS_DATA_PATH env vars,
// which outrank every configured path in getDatabases()/resolveDatabaseStorageRoot.

const assert = require('node:assert');
const path = require('node:path');
const { setupTestDBPath } = require('./testUtils.js');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { getConfigPath } = require('#src/config/configUtils');
const { resolveDatabaseStorageRoot } = require('#src/resources/databases');

const ENV_DIR_PATH = path.join(__dirname, 'envDir') + path.sep;

describe('unit-test per-PID root isolation', () => {
	it('neutralizes ambient storage-path env vars', () => {
		assert.strictEqual(process.env.STORAGE_PATH, undefined);
		assert.strictEqual(process.env.SCHEMAS_DATA_PATH, undefined);
	});

	it('neutralizes ambient storage-path env vars a parent shell exported', function () {
		this.timeout(30000);
		const { spawnSync } = require('node:child_process');
		const result = spawnSync(
			process.execPath,
			['--require', './unitTests/mocha.init.js', '-p', '[process.env.STORAGE_PATH, process.env.SCHEMAS_DATA_PATH]'],
			{
				cwd: path.join(__dirname, '..'),
				env: { ...process.env, STORAGE_PATH: '/tmp/ambient-storage', SCHEMAS_DATA_PATH: '/tmp/ambient-schemas' },
				encoding: 'utf8',
			}
		);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout.trim().split('\n').pop(), '[ undefined, undefined ]');
	});

	it('exports ROOTPATH inside the per-PID directory for worker threads and spawned processes', () => {
		assert.ok(process.env.ROOTPATH?.startsWith(ENV_DIR_PATH), process.env.ROOTPATH);
	});

	it('resolves the Harper root and storage path inside the per-PID directory', () => {
		assert.ok(env.getHdbBasePath().startsWith(ENV_DIR_PATH), env.getHdbBasePath());
		const storagePath = getConfigPath(terms.CONFIG_PARAMS.STORAGE_PATH);
		assert.ok(storagePath.startsWith(ENV_DIR_PATH), storagePath);
	});

	it('resolves every configured database — system included — inside the per-PID directory', () => {
		setupTestDBPath();
		const databases = env.get(terms.CONFIG_PARAMS.DATABASES);
		for (const name in databases) {
			assert.ok(databases[name].path.startsWith(ENV_DIR_PATH), `${name}: ${databases[name].path}`);
		}
		const systemRoot = resolveDatabaseStorageRoot('system');
		assert.ok(systemRoot.startsWith(ENV_DIR_PATH), systemRoot);
	});
});
