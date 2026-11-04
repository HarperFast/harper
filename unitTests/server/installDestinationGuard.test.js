'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

function fingerprint(directory) {
	const result = {};
	function visit(current) {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const target = path.join(current, entry.name);
			if (entry.isDirectory()) visit(target);
			else
				result[path.relative(directory, target)] = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
		}
	}
	visit(directory);
	return result;
}

function run(phase, env, expectedStatus = 0) {
	const child = spawnSync(
		process.execPath,
		[
			...process.execArgv.filter((arg) => arg.startsWith('--conditions=')),
			...(phase === 'cli'
				? [require.resolve('#src/bin/harper'), env.GUARD_CLI_SERVICE || 'install']
				: [path.join(__dirname, 'fixtures/installDestinationGuard.cjs'), phase]),
			...(env.GUARD_STORAGE_ARG ? ['--STORAGE_PATH', env.GUARD_STORAGE_ARG] : []),
		],
		{ cwd: path.resolve(__dirname, '../..'), env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	const output = `${child.stdout}\n${child.stderr}`;
	assert.ifError(child.error);
	assert.strictEqual(child.status, expectedStatus, output);
	return output;
}

function installEnv(temp, name, engine) {
	const root = path.join(temp, name);
	fs.mkdirSync(root);
	const config = path.join(root, 'harper-config.yaml');
	fs.writeFileSync(
		config,
		YAML.stringify({
			rootPath: root,
			http: { port: null, securePort: null },
			operationsApi: { network: { port: null, securePort: null } },
			analytics: { aggregatePeriod: -1 },
		})
	);
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^(HARPER_|STORAGE_|DATABASES|HDB_|GUARD_|SCHEMAS_DATA_PATH$|ROOTPATH$|DEFAULTS_MODE$)/.test(key))
			delete env[key];
	}
	return {
		...env,
		ROOTPATH: root,
		HDB_CONFIG: config,
		HOME: path.join(temp, `${name}-home`),
		USERPROFILE: path.join(temp, `${name}-home`),
		HDB_ADMIN_USERNAME: 'admin',
		HDB_ADMIN_PASSWORD: 'original-guard-password',
		DEFAULTS_MODE: 'prod',
		HARPER_STORAGE_ENGINE: engine,
	};
}

function cliEnv(temp, name, engine) {
	const env = installEnv(temp, name, engine);
	const config = YAML.parse(fs.readFileSync(path.join(__dirname, '../../static/defaultConfig.yaml'), 'utf8'));
	config.rootPath = env.ROOTPATH;
	config.http.port = config.http.securePort = null;
	config.operationsApi.network.port = config.operationsApi.network.securePort = null;
	config.operationsApi.network.domainSocket = false;
	config.analytics.aggregatePeriod = -1;
	for (const dir of ['database', 'backup', 'keys', 'log', 'components']) fs.mkdirSync(path.join(env.ROOTPATH, dir));
	fs.writeFileSync(env.HDB_CONFIG, YAML.stringify(config));
	return env;
}

describe('effective installation destination protection', function () {
	for (const engine of ['rocksdb', 'lmdb']) {
		it(`refuses existing ${engine} stores without opening or changing them`, function () {
			const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-install-guard-'));
			try {
				const storage = path.join(temp, 'external');
				fs.mkdirSync(storage);
				const seed = installEnv(temp, 'seed', engine);
				seed.STORAGE_PATH = storage;
				const userStorage = path.join(storage, 'users');
				fs.mkdirSync(userStorage);
				seed.GUARD_SNAPSHOT = path.join(temp, 'admin.json');
				assert.match(run('seed', seed), /install-destination-guard-ok/);
				assert(
					fs.existsSync(path.join(storage, engine === 'lmdb' ? 'system.mdb' : 'system/CURRENT')),
					JSON.stringify(fingerprint(storage))
				);
				fs.cpSync(
					path.join(storage, engine === 'lmdb' ? 'system.mdb' : 'system'),
					path.join(userStorage, engine === 'lmdb' ? 'hdb_user.mdb' : 'hdb_user'),
					{ recursive: true }
				);
				const originalConfig = fs.readFileSync(seed.HDB_CONFIG);
				const originalRoot = fingerprint(seed.ROOTPATH);
				const originalStore = fingerprint(storage);
				const modes = [
					['HARPER_CONFIG', { storage: { path: storage } }],
					['HARPER_SET_CONFIG', { storage: { path: storage } }],
					['HARPER_CONFIG', { databases: { system: { path: storage } } }],
					['HARPER_SET_CONFIG', { databases: { system: { path: storage } } }],
					['STORAGE_PATH', storage],
					['GUARD_STORAGE_ARG', storage],
					['DATABASES', [{ system: { path: storage } }]],
					['DATABASES', [{ system: { tables: { hdb_user: { path: userStorage } } } }]],
					['HARPER_CONFIG', { storage: { path: storage } }, 'opposite'],
					['HARPER_CONFIG', { databases: { system: { path: path.relative(process.cwd(), storage) } } }],
					['STORAGE_PATH', path.relative(process.cwd(), storage)],
					['HARPER_CONFIG', { databases: { system: { tables: { hdb_user: { path: userStorage } } } } }],
					['HARPER_SET_CONFIG', { databases: { system: { tables: { hdb_user: { path: userStorage } } } } }],
				];
				for (const [index, [key, value, selectedEngine]] of modes.entries()) {
					const env = installEnv(temp, `attempt-${index}`, engine);
					env[key] = typeof value === 'string' ? value : JSON.stringify(value);
					if (selectedEngine === 'opposite') env.HARPER_STORAGE_ENGINE = engine === 'lmdb' ? 'rocksdb' : 'lmdb';
					env.HDB_ADMIN_PASSWORD = 'replacement-guard-password';
					const template = fs.readFileSync(env.HDB_CONFIG);
					const output = run('install', env);
					assert.match(output, /already installed/, `${engine} ${key}: ${output}`);
					assert.doesNotMatch(output, /install-destination-guard-ok/);
					assert.deepStrictEqual(fingerprint(storage), originalStore, `${engine} ${key} opened or changed a store`);
					assert.deepStrictEqual(fs.readFileSync(env.HDB_CONFIG), template);
					assert.deepStrictEqual(fs.readdirSync(env.ROOTPATH), ['harper-config.yaml']);
				}
				const legacy = installEnv(temp, 'legacy', engine);
				fs.mkdirSync(path.join(legacy.ROOTPATH, 'database'));
				fs.mkdirSync(path.join(legacy.ROOTPATH, 'schema'));
				const leaf = engine === 'lmdb' ? 'system.mdb' : 'system';
				fs.cpSync(path.join(storage, leaf), path.join(legacy.ROOTPATH, 'schema', leaf), { recursive: true });
				const legacyBefore = fingerprint(legacy.ROOTPATH);
				assert.match(run('install', legacy), /already installed/);
				assert.deepStrictEqual(fingerprint(legacy.ROOTPATH), legacyBefore);
				if (engine === 'rocksdb') {
					const partial = installEnv(temp, 'partial', engine);
					partial.STORAGE_PATH = path.join(temp, 'partial-storage');
					fs.mkdirSync(partial.STORAGE_PATH);
					fs.cpSync(path.join(storage, leaf), path.join(partial.STORAGE_PATH, leaf), { recursive: true });
					fs.unlinkSync(path.join(partial.STORAGE_PATH, leaf, 'CURRENT'));
					const partialBefore = fingerprint(partial.STORAGE_PATH);
					assert.match(run('install', partial), /already installed/);
					assert.deepStrictEqual(fingerprint(partial.STORAGE_PATH), partialBefore);
				}
				assert.deepStrictEqual(fs.readFileSync(seed.HDB_CONFIG), originalConfig);
				assert.deepStrictEqual(fingerprint(seed.ROOTPATH), originalRoot);
				assert.match(run('verify', seed), /install-destination-guard-ok/);
			} finally {
				fs.rmSync(temp, { recursive: true, force: true });
			}
		});

		it(`allows fresh and empty ${engine} destinations and the explicit override`, function () {
			const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-install-empty-'));
			try {
				for (const empty of [false, true, 'default']) {
					const env = installEnv(temp, `fresh-${empty}`, engine);
					env.STORAGE_PATH = path.join(temp, `storage-${empty}`);
					fs.mkdirSync(env.STORAGE_PATH);
					if (empty === true) {
						fs.mkdirSync(path.join(env.STORAGE_PATH, 'system'));
						fs.writeFileSync(path.join(env.STORAGE_PATH, 'mount-marker'), 'shared parent');
						const template = YAML.parse(fs.readFileSync(env.HDB_CONFIG, 'utf8'));
						template.databases = { system: { path: env.STORAGE_PATH } };
						fs.writeFileSync(env.HDB_CONFIG, YAML.stringify(template));
						delete env.STORAGE_PATH;
					}
					if (empty === 'default') {
						delete env.STORAGE_PATH;
						fs.mkdirSync(path.join(env.ROOTPATH, 'database/system'), { recursive: true });
					}
					assert.match(run('install', env), /install-destination-guard-ok/);
					assert.match(run('boot', env), /install-destination-guard-ok/);
					if (empty === false) {
						const override = installEnv(temp, `override-${empty}`, engine);
						override.STORAGE_PATH = env.STORAGE_PATH || path.join(env.ROOTPATH, 'database');
						override.GUARD_OVERRIDE = 'true';
						assert.match(run('install', override), /install-destination-guard-ok/);

						const reattach = installEnv(temp, 'reattach', engine);
						fs.unlinkSync(reattach.HDB_CONFIG);
						delete reattach.HDB_CONFIG;
						reattach.STORAGE_PATH = env.STORAGE_PATH;
						assert.match(run('install', reattach), /install-destination-guard-ok/);
					}
				}
			} finally {
				fs.rmSync(temp, { recursive: true, force: true });
			}
		});
	}
	for (const engine of ['rocksdb', 'lmdb']) {
		it(`preserves config at the real ${engine} CLI import boundary and commits state on success`, function () {
			const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-cli-install-guard-'));
			try {
				const storage = path.join(temp, 'existing');
				fs.mkdirSync(storage);
				const seed = installEnv(temp, 'seed', engine);
				seed.STORAGE_PATH = storage;
				seed.GUARD_SNAPSHOT = path.join(temp, 'admin.json');
				assert.match(run('seed', seed), /install-destination-guard-ok/);
				const originalStore = fingerprint(storage);
				for (const key of ['HARPER_CONFIG', 'HARPER_SET_CONFIG']) {
					const env = cliEnv(temp, key, engine);
					env[key] = JSON.stringify({ storage: { path: storage } });
					if (key === 'HARPER_SET_CONFIG') {
						env.GUARD_CLI_SERVICE = 'INSTALL';
						const template = YAML.parse(fs.readFileSync(env.HDB_CONFIG, 'utf8'));
						delete template.storage.path;
						delete template.logging.rotation.path;
						delete template.authentication;
						delete template.analytics;
						fs.writeFileSync(env.HDB_CONFIG, YAML.stringify(template));
					}
					const before = fs.readFileSync(env.HDB_CONFIG);
					const output = run('cli', env);
					assert.match(output, /already installed/);
					assert.deepStrictEqual(
						fs.readFileSync(env.HDB_CONFIG),
						before,
						'CLI import rewrote the template before refusal'
					);
					assert.strictEqual(fs.existsSync(path.join(env.ROOTPATH, 'backup/.harper-config-state.json')), false);
					assert.deepStrictEqual(fingerprint(storage), originalStore, 'CLI refusal opened the occupied store');
				}
				assert.match(run('verify', seed), /install-destination-guard-ok/);
				const fresh = cliEnv(temp, 'fresh', engine);
				const freshStorage = path.join(temp, 'fresh-storage');
				fs.mkdirSync(freshStorage);
				const template = YAML.parse(fs.readFileSync(fresh.HDB_CONFIG, 'utf8'));
				template.storage.path = freshStorage;
				fs.writeFileSync(fresh.HDB_CONFIG, YAML.stringify(template));
				fresh.HARPER_CONFIG = JSON.stringify({ authentication: { cacheTTL: 60000 } });
				assert.match(run('cli', fresh), /installation was successful/);
				const state = JSON.parse(fs.readFileSync(path.join(fresh.ROOTPATH, 'backup/.harper-config-state.json')));
				assert.strictEqual(state.originalValues['authentication.cacheTTL'], 30000);
				assert.strictEqual(YAML.parse(fs.readFileSync(fresh.HDB_CONFIG, 'utf8')).authentication.cacheTTL, 60000);
				delete fresh.HARPER_CONFIG;
				assert.match(run('boot', fresh), /install-destination-guard-ok/);
				assert.strictEqual(YAML.parse(fs.readFileSync(fresh.HDB_CONFIG, 'utf8')).authentication.cacheTTL, 30000);
			} finally {
				fs.rmSync(temp, { recursive: true, force: true });
			}
		});

		for (const mount of ['system', 'table', 'absent']) {
			const perTable = mount === 'table';
			const preserveEmpty = mount !== 'absent';
			it(`rolls back a failed ${engine} install in an empty ${mount} mount and permits retry`, function () {
				const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-install-empty-retry-'));
				try {
					const env = installEnv(temp, 'root', engine);
					const parent = perTable ? path.join(temp, 'table-storage') : path.join(env.ROOTPATH, 'database');
					const leaf = path.join(parent, perTable ? 'hdb_user' : 'system');
					fs.mkdirSync(preserveEmpty ? leaf : parent, { recursive: true });
					if (perTable) {
						const template = YAML.parse(fs.readFileSync(env.HDB_CONFIG, 'utf8'));
						template.databases = { system: { tables: { hdb_user: { path: parent } } } };
						fs.writeFileSync(env.HDB_CONFIG, YAML.stringify(template));
					}
					const before = fs.readFileSync(env.HDB_CONFIG);
					const blockedHome = path.join(temp, 'blocked-home');
					fs.writeFileSync(blockedHome, 'preserve this file');
					env.HOME = env.USERPROFILE = blockedHome;
					const failure = run('install', env, 1);
					assert.doesNotMatch(failure, /installation was successful/);
					assert.match(failure, /blocked-home[\\/]+\.harperdb[\\/]+hdb_boot_properties\.file/);
					assert.deepStrictEqual(fs.readFileSync(env.HDB_CONFIG), before);
					if (preserveEmpty) {
						assert.deepStrictEqual(fs.readdirSync(leaf), [], 'new database artifacts survived inside the empty mount');
					} else assert.strictEqual(fs.existsSync(leaf), false);
					assert.deepStrictEqual(fs.readdirSync(parent), preserveEmpty ? [path.basename(leaf)] : []);
					assert.strictEqual(fs.readFileSync(blockedHome, 'utf8'), 'preserve this file');
					env.HOME = env.USERPROFILE = path.join(temp, 'valid-home');
					assert.match(run('install', env), /install-destination-guard-ok/);
				} finally {
					fs.rmSync(temp, { recursive: true, force: true });
				}
			});
		}
	}
	it('preserves pending recovery evidence on CLI refusal and retires it after successful publication', function () {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-install-pending-'));
		try {
			const env = installEnv(temp, 'root', 'rocksdb');
			env.GUARD_SNAPSHOT = path.join(temp, 'admin.json');
			env.HARPER_DEFAULT_CONFIG = JSON.stringify({ authentication: { cacheTTL: 45000 } });
			assert.match(run('seed', env), /install-destination-guard-ok/);
			env.HARPER_DEFAULT_CONFIG = JSON.stringify({ authentication: { cacheTTL: 60000 } });
			assert.match(run('pending', env), /install-destination-guard-ok/);
			const backup = path.join(env.ROOTPATH, 'backup');
			const pendingNames = () =>
				fs.readdirSync(backup).filter((name) => name.startsWith('.harper-config-state.pending.'));
			assert.strictEqual(pendingNames().length, 1);
			const beforeState = fingerprint(backup);
			const beforeConfig = fs.readFileSync(env.HDB_CONFIG);
			assert.match(run('cli', env), /already installed/);
			assert.deepStrictEqual(fingerprint(backup), beforeState, 'refusal consumed interrupted-commit evidence');
			assert.deepStrictEqual(fs.readFileSync(env.HDB_CONFIG), beforeConfig);
			assert.match(run('boot', env), /install-destination-guard-ok/);
			env.HARPER_DEFAULT_CONFIG = JSON.stringify({ authentication: { cacheTTL: 70000 } });
			assert.match(run('boot', env), /install-destination-guard-ok/);
			assert.strictEqual(YAML.parse(fs.readFileSync(env.HDB_CONFIG, 'utf8')).authentication.cacheTTL, 70000);
			env.HARPER_DEFAULT_CONFIG = JSON.stringify({ authentication: { cacheTTL: 80000 } });
			assert.match(run('pending', env), /install-destination-guard-ok/);
			assert.strictEqual(pendingNames().length, 1);
			env.GUARD_OVERRIDE = 'true';
			assert.match(run('install', env), /install-destination-guard-ok/);
			assert.deepStrictEqual(pendingNames(), []);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});
	it('keeps runtime DEFAULT precedence while checking an existing non-template installation', function () {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-install-runtime-default-'));
		try {
			const env = installEnv(temp, 'root', 'rocksdb');
			const original = path.join(temp, 'original');
			const other = path.join(temp, 'other');
			fs.mkdirSync(original);
			fs.mkdirSync(other);
			env.STORAGE_PATH = original;
			assert.match(run('install', env), /install-destination-guard-ok/);
			const configPath = env.HDB_CONFIG;
			const before = fs.readFileSync(configPath);
			delete env.HDB_CONFIG;
			delete env.STORAGE_PATH;
			env.HARPER_DEFAULT_CONFIG = JSON.stringify({ storage: { path: other } });
			const output = run('cli', env);
			assert.match(output, /already installed/);
			assert.deepStrictEqual(fs.readFileSync(configPath), before);
			assert.deepStrictEqual(fs.readdirSync(other), []);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});
});
