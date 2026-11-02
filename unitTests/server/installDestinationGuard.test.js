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

function run(phase, env) {
	const child = spawnSync(
		process.execPath,
		[
			...process.execArgv.filter((arg) => arg.startsWith('--conditions=')),
			path.join(__dirname, 'fixtures/installDestinationGuard.cjs'),
			phase,
			...(env.GUARD_STORAGE_ARG ? ['--STORAGE_PATH', env.GUARD_STORAGE_ARG] : []),
		],
		{ cwd: path.resolve(__dirname, '../..'), env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	const output = `${child.stdout}\n${child.stderr}`;
	assert.ifError(child.error);
	assert.strictEqual(child.status, 0, output);
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
});
