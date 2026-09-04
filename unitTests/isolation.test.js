'use strict';

// Regression coverage for the per-PID root contract mocha.init.js establishes — see its
// header comment for the contract.

const assert = require('node:assert');
const fs = require('fs-extra');
const path = require('node:path');
const env = require('#src/utility/environment/environmentManager');
const terms = require('#src/utility/hdbTerms');
const { getConfigPath } = require('#src/config/configUtils');
const { resolveDatabaseStorageRoot } = require('#src/resources/databases');

const ENV_DIR_PATH = path.join(__dirname, 'envDir') + path.sep;
const PROBE_OUTPUT_PREFIX = 'PER_PID_ROOT_PROBE:';

describe('unit-test per-PID root isolation', () => {
	it('neutralizes ambient storage-path env vars', () => {
		assert.strictEqual(process.env.STORAGE_PATH, undefined);
		assert.strictEqual(process.env.SCHEMAS_DATA_PATH, undefined);
	});

	it('a fresh process neutralizes ambient env vars and resolves config, storage, and the system database inside its per-PID root', function () {
		this.timeout(30000);
		const { spawnSync } = require('node:child_process');
		const probe =
			"const env = require('#src/utility/environment/environmentManager');" +
			"const terms = require('#src/utility/hdbTerms');" +
			"const { getConfigPath } = require('#src/config/configUtils');" +
			"const { resolveDatabaseStorageRoot } = require('#src/resources/databases');" +
			'const before = [process.pid, process.env.STORAGE_PATH, process.env.SCHEMAS_DATA_PATH, ' +
			'env.getHdbBasePath(), getConfigPath(terms.CONFIG_PARAMS.STORAGE_PATH), ' +
			"resolveDatabaseStorageRoot('system'), getConfigPath(terms.HDB_SETTINGS_NAMES.LOG_PATH_KEY)];" +
			// a re-init through the function preTestPrep() stubs initSync with must keep the
			// same layout, or it detaches databases seeded under <root>/database
			'env.initTestEnvironment({});' +
			`console.log('${PROBE_OUTPUT_PREFIX}' + JSON.stringify(before.concat([getConfigPath(terms.CONFIG_PARAMS.STORAGE_PATH)])));`;
		const result = spawnSync(process.execPath, ['--require', './unitTests/mocha.init.js', '-e', probe], {
			cwd: path.join(__dirname, '..'),
			env: { ...process.env, STORAGE_PATH: '/tmp/ambient-storage', SCHEMAS_DATA_PATH: '/tmp/ambient-schemas' },
			encoding: 'utf8',
			timeout: 25000,
		});
		const childRoot = result.pid ? path.join(__dirname, 'envDir', String(result.pid)) : null;
		try {
			assert.strictEqual(result.status, 0, result.stderr);
			const probeOutput = result.stdout.split('\n').find((line) => line.startsWith(PROBE_OUTPUT_PREFIX));
			assert.ok(probeOutput, result.stdout);
			const [childPid, storageEnv, schemasEnv, hdbRoot, storagePath, systemRoot, logPath, storageAfterReinit] =
				JSON.parse(probeOutput.slice(PROBE_OUTPUT_PREFIX.length));
			assert.strictEqual(childPid, result.pid);
			assert.strictEqual(storageEnv, null);
			assert.strictEqual(schemasEnv, null);
			for (const resolved of [hdbRoot, storagePath, systemRoot, logPath, storageAfterReinit]) {
				assert.ok(
					typeof resolved === 'string' && (resolved === childRoot || resolved.startsWith(childRoot + path.sep)),
					String(resolved)
				);
			}
			assert.strictEqual(storageAfterReinit, path.join(childRoot, 'database'), storageAfterReinit);
		} finally {
			if (childRoot) fs.removeSync(childRoot);
		}
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
		const databases = env.get(terms.CONFIG_PARAMS.DATABASES);
		for (const name in databases) {
			assert.ok(databases[name].path.startsWith(ENV_DIR_PATH), `${name}: ${databases[name].path}`);
		}
		const systemRoot = resolveDatabaseStorageRoot('system');
		assert.ok(systemRoot.startsWith(ENV_DIR_PATH), systemRoot);
	});
});
