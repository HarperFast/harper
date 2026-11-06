'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const {
	atomicWriteFile,
	getConfigFilePath,
	initConfig,
	setConfiguration,
	writeStagedInstallConfig,
} = require('#src/config/configUtils');
const { getBackupDirPath } = require('#src/config/configHelpers');
const { prepareRuntimeEnvConfig } = require('#src/config/harperConfigEnvVars');
const env = require('#src/utility/environment/environmentManager');
const hdbTerms = require('#src/utility/hdbTerms');
const { default: checkJWTTokenExist } = require('#src/utility/install/checkJWTTokensExist');
const { preserveRootConfig, readRootConfig } = require('../rootConfigFixture.js');

const PERMISSIVE_UMASK = 0o002;
const UMASK_DEFAULT_MODE = 0o666 & ~PERMISSIVE_UMASK;

function modeOf(filePath) {
	return fs.statSync(filePath).mode & 0o777;
}

function writeWithMode(filePath, content, mode) {
	fs.writeFileSync(filePath, content);
	fs.chmodSync(filePath, mode);
}

function tempFilesIn(directory) {
	return fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'));
}

/** configUtils calls fs through fs-extra's module object, so that is where `wrapper` intercepts it. */
function wrapFs(name, wrapper) {
	const original = fs[name];
	fs[name] = (...args) => wrapper(original, ...args);
	return () => {
		fs[name] = original;
	};
}

describe('owner-only modes for files that can hold secrets (harper#1925)', function () {
	let savedUmask;
	let testRoot;

	before(function () {
		if (process.platform === 'win32') this.skip();
		savedUmask = process.umask(PERMISSIVE_UMASK);
	});

	after(function () {
		if (savedUmask !== undefined) process.umask(savedUmask);
	});

	beforeEach(function () {
		testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-1925-'));
	});

	afterEach(function () {
		fs.chmodSync(testRoot, 0o700);
		fs.removeSync(testRoot);
	});

	describe('atomicWriteFile ownerOnly', function () {
		it('creates a new file owner-only, while a write without the option keeps the umask default', function () {
			const secret = path.join(testRoot, 'secret.yaml');
			const plain = path.join(testRoot, 'plain.yaml');
			atomicWriteFile(secret, 'apiKey: synthetic-value\n', { ownerOnly: true });
			atomicWriteFile(plain, 'port: 9926\n');

			assert.strictEqual(modeOf(secret), 0o600);
			assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'apiKey: synthetic-value\n');
			assert.strictEqual(modeOf(plain), UMASK_DEFAULT_MODE);
		});

		for (const durable of [false, true]) {
			const label = durable ? 'a durable write' : 'a write';
			it(`${label} narrows a permissive file it replaces to owner-only`, function () {
				const target = path.join(testRoot, 'config.yaml');
				writeWithMode(target, 'old\n', 0o664);
				atomicWriteFile(target, 'new\n', { ownerOnly: true, durable });
				assert.strictEqual(modeOf(target), 0o600);
				assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new\n');
			});

			it(`${label} keeps a stricter mode on the file it replaces`, function () {
				const target = path.join(testRoot, 'config.yaml');
				writeWithMode(target, 'old\n', 0o400);
				atomicWriteFile(target, 'new\n', { ownerOnly: true, durable });
				assert.strictEqual(modeOf(target), 0o400);
				assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new\n');
			});

			it(`${label} keeps its temp file owner-only until the rename publishes it`, function () {
				const target = path.join(testRoot, 'config.yaml');
				writeWithMode(target, 'old\n', 0o664);
				const atRename = [];
				const restore = wrapFs('renameSync', (original, from, to) => {
					atRename.push(modeOf(from));
					return original(from, to);
				});
				try {
					atomicWriteFile(target, 'apiKey: synthetic-value\n', { ownerOnly: true, durable });
				} finally {
					restore();
				}
				assert.deepStrictEqual(atRename, [0o600]);
			});

			it(`${label} removes its own temp and leaves the target intact when the write fails part-way`, function () {
				const target = path.join(testRoot, 'config.yaml');
				writeWithMode(target, 'old\n', 0o400);
				const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
				const restore = wrapFs('writeFileSync', (original, file, content, ...rest) => {
					if (typeof file === 'string' && !file.endsWith('.tmp')) return original(file, content, ...rest);
					original(file, 'apiKey: synth', ...rest);
					throw enospc;
				});
				try {
					assert.throws(
						() => atomicWriteFile(target, 'apiKey: synthetic-value\n', { ownerOnly: true, durable }),
						enospc
					);
				} finally {
					restore();
				}
				assert.deepStrictEqual(tempFilesIn(testRoot), []);
				assert.strictEqual(fs.readFileSync(target, 'utf8'), 'old\n');
				assert.strictEqual(modeOf(target), 0o400);
			});
		}

		it('takes its mode from the file a later rename publishes it over', function () {
			const confirmed = path.join(testRoot, 'state.json');
			const staged = path.join(testRoot, 'state.pending.json');
			writeWithMode(confirmed, '{}\n', 0o400);
			atomicWriteFile(staged, '{"a":1}\n', { ownerOnly: true, replaces: confirmed });
			assert.strictEqual(modeOf(staged), 0o400);

			fs.unlinkSync(confirmed);
			atomicWriteFile(staged, '{"a":2}\n', { ownerOnly: true, replaces: confirmed });
			assert.strictEqual(modeOf(staged), 0o600, 'an absent destination imposes nothing narrower');
		});

		it('takes no mode from a file another user owns', function () {
			// A file Harper reads only through its group or other bits would otherwise yield an unreadable 0o000.
			const foreign = ['/etc/sudoers'].find((candidate) => {
				const stats = nodeFs.statSync(candidate, { throwIfNoEntry: false });
				return stats && stats.uid !== process.getuid() && (stats.mode & 0o600) !== 0o600;
			});
			if (!foreign) this.skip();
			const staged = path.join(testRoot, 'config.yaml');
			atomicWriteFile(staged, 'new\n', { ownerOnly: true, replaces: foreign });
			assert.strictEqual(modeOf(staged), 0o600);
		});

		it('leaves the file, its mode and its mtime alone when an unchanged write is skipped', function () {
			const target = path.join(testRoot, 'config.yaml');
			writeWithMode(target, 'same\n', 0o664);
			const mtimeBefore = fs.statSync(target).mtimeMs;
			assert.strictEqual(atomicWriteFile(target, 'same\n', { ownerOnly: true, skipIfUnchanged: true }), false);
			assert.strictEqual(modeOf(target), 0o664);
			assert.strictEqual(fs.statSync(target).mtimeMs, mtimeBefore);
		});

		it('writes nothing when it cannot read the mode of the file it replaces', function () {
			// Only an absent file means no mode to keep; guessing on EIO could widen a 0o400 file.
			const target = path.join(testRoot, 'config.yaml');
			writeWithMode(target, 'old\n', 0o400);
			const eio = Object.assign(new Error('EIO: i/o error, stat'), { code: 'EIO' });
			const restore = wrapFs('statSync', (original, file, ...rest) => {
				if (file === target) throw eio;
				return original(file, ...rest);
			});
			try {
				assert.throws(() => atomicWriteFile(target, 'new\n', { ownerOnly: true }), eio);
			} finally {
				restore();
			}
			assert.deepStrictEqual(tempFilesIn(testRoot), []);
			assert.strictEqual(fs.readFileSync(target, 'utf8'), 'old\n');
			assert.strictEqual(modeOf(target), 0o400);
		});

		// The plain branch creates its temp in writeFileSync, the durable one in openSync.
		for (const [durable, creatingCall] of [
			[false, 'writeFileSync'],
			[true, 'openSync'],
		]) {
			it(`leaves alone a file it did not create when its temp name is already taken (${creatingCall})`, function () {
				const target = path.join(testRoot, 'config.yaml');
				writeWithMode(target, 'old\n', 0o600);
				let squatted;
				const restore = wrapFs(creatingCall, (original, file, ...rest) => {
					if (squatted === undefined && typeof file === 'string' && file.endsWith('.tmp')) {
						squatted = file;
						nodeFs.writeFileSync(file, 'not ours\n');
					}
					return original(file, ...rest);
				});
				try {
					assert.throws(() => atomicWriteFile(target, 'new\n', { ownerOnly: true, durable }), { code: 'EEXIST' });
				} finally {
					restore();
				}
				assert.strictEqual(nodeFs.readFileSync(squatted, 'utf8'), 'not ours\n');
				assert.strictEqual(fs.readFileSync(target, 'utf8'), 'old\n');
			});
		}

		it('creates the durable temp owner-only before the first byte is written', function () {
			const target = path.join(testRoot, 'config.yaml');
			writeWithMode(target, 'old\n', 0o664);
			const atFirstByte = [];
			const restore = wrapFs('writeFileSync', (original, file, ...rest) => {
				if (typeof file === 'number') atFirstByte.push(fs.fstatSync(file).mode & 0o777);
				return original(file, ...rest);
			});
			try {
				atomicWriteFile(target, 'apiKey: synthetic-value\n', { ownerOnly: true, durable: true });
			} finally {
				restore();
			}
			assert.deepStrictEqual(atFirstByte, [0o600]);
		});

		it('hands the plain temp its mode in the call that creates it', function () {
			// That call creates and writes in one native step, so there is no earlier point to observe.
			const target = path.join(testRoot, 'config.yaml');
			writeWithMode(target, 'old\n', 0o664);
			const creations = [];
			const restore = wrapFs('writeFileSync', (original, file, content, options) => {
				if (typeof file === 'string' && file.endsWith('.tmp')) creations.push(options);
				return original(file, content, options);
			});
			try {
				atomicWriteFile(target, 'apiKey: synthetic-value\n', { ownerOnly: true });
			} finally {
				restore();
			}
			assert.deepStrictEqual(creations, [{ flag: 'wx', mode: 0o600 }]);
		});

		it('removes its temp and leaves the destination when the rename fails', function () {
			const target = path.join(testRoot, 'occupied');
			fs.mkdirSync(target);
			fs.writeFileSync(path.join(target, 'entry'), 'kept\n');
			assert.throws(() => atomicWriteFile(target, 'new\n', { ownerOnly: true }));
			assert.deepStrictEqual(tempFilesIn(testRoot), []);
			assert.strictEqual(fs.readFileSync(path.join(target, 'entry'), 'utf8'), 'kept\n');
		});
	});

	describe('root config writers', function () {
		let configMode;
		let backupsBefore;

		beforeEach(function () {
			configMode = modeOf(getConfigFilePath());
			backupsBefore = new Set(fs.readdirSync(backupDir()));
		});

		// Before preserveRootConfig's restore, which writes in place and so needs the mode back first.
		afterEach(function () {
			fs.chmodSync(getConfigFilePath(), configMode);
		});
		preserveRootConfig();
		afterEach(function () {
			for (const name of fs.readdirSync(backupDir())) {
				if (!backupsBefore.has(name)) fs.removeSync(path.join(backupDir(), name));
			}
			initConfig(true);
		});

		function backupDir() {
			const directory = getBackupDirPath(env.get(hdbTerms.CONFIG_PARAMS.ROOTPATH));
			fs.ensureDirSync(directory);
			return directory;
		}

		it('writes the install config owner-only', function () {
			const target = path.join(testRoot, hdbTerms.HARPER_CONFIG_FILE);
			const configDoc = YAML.parseDocument(fs.readFileSync(getConfigFilePath(), 'utf8'));
			writeStagedInstallConfig({ configDoc, validated: true }, target);
			assert.strictEqual(modeOf(target), 0o600);
			assert.strictEqual(fs.readFileSync(target, 'utf8'), String(configDoc));
		});

		it('set_configuration replaces a permissive config owner-only and backs it up owner-only', async function () {
			const configPath = getConfigFilePath();
			fs.chmodSync(configPath, 0o664);
			const original = fs.readFileSync(configPath);

			await setConfiguration({ operation: 'set_configuration', logging_level: 'fatal' });

			assert.strictEqual(readRootConfig().logging?.level, 'fatal');
			assert.strictEqual(modeOf(configPath), 0o600);
			const backups = fs.readdirSync(backupDir()).filter((name) => !backupsBefore.has(name) && name.endsWith('.bak'));
			assert.strictEqual(backups.length, 1, `expected one new backup, found ${backups}`);
			const backupPath = path.join(backupDir(), backups[0]);
			assert.strictEqual(modeOf(backupPath), 0o600, 'the backup does not inherit the permissive source mode');
			assert.ok(fs.readFileSync(backupPath).equals(original), 'the backup holds the previous bytes exactly');
		});

		it('set_configuration keeps a stricter config mode', async function () {
			const configPath = getConfigFilePath();
			fs.chmodSync(configPath, 0o400);
			await setConfiguration({ operation: 'set_configuration', logging_level: 'fatal' });
			assert.strictEqual(readRootConfig().logging?.level, 'fatal');
			assert.strictEqual(modeOf(configPath), 0o400);
		});
	});

	describe('env config state', function () {
		let savedSetConfig;

		beforeEach(function () {
			savedSetConfig = process.env.HARPER_SET_CONFIG;
		});

		afterEach(function () {
			if (savedSetConfig === undefined) delete process.env.HARPER_SET_CONFIG;
			else process.env.HARPER_SET_CONFIG = savedSetConfig;
		});

		function statePath() {
			return path.join(testRoot, hdbTerms.BACKUP_DIR_NAME, '.harper-config-state.json');
		}

		function commitEnvConfig(port) {
			process.env.HARPER_SET_CONFIG = JSON.stringify({ http: { port } });
			const { saveState, confirmConfigWritten } = prepareRuntimeEnvConfig({ http: { port: 9926 } }, testRoot);
			assert.strictEqual(saveState(), true);
			assert.strictEqual(confirmConfigWritten(), true);
		}

		it('writes the state file owner-only', function () {
			commitEnvConfig(8123);
			assert.strictEqual(modeOf(statePath()), 0o600);
		});

		it('keeps a stricter state-file mode across a staged commit', function () {
			commitEnvConfig(8123);
			fs.chmodSync(statePath(), 0o400);
			commitEnvConfig(8124);
			assert.strictEqual(
				JSON.parse(fs.readFileSync(statePath(), 'utf8')).snapshots.HARPER_SET_CONFIG.config.http.port,
				8124
			);
			assert.strictEqual(modeOf(statePath()), 0o400);
		});
	});

	describe('JWT signing keys', function () {
		let savedBasePath;
		let keysDir;

		beforeEach(function () {
			savedBasePath = env.getHdbBasePath();
			env.setHdbBasePath(testRoot);
			keysDir = path.join(testRoot, hdbTerms.LICENSE_KEY_DIR_NAME);
			fs.mkdirSync(keysDir);
		});

		afterEach(function () {
			env.setHdbBasePath(savedBasePath);
		});

		function keyPath(name) {
			return path.join(keysDir, name);
		}

		function assertUsableKeyPair() {
			const privateKey = crypto.createPrivateKey({
				key: fs.readFileSync(keyPath(hdbTerms.JWT_ENUM.JWT_PRIVATE_KEY_NAME)),
				passphrase: fs.readFileSync(keyPath(hdbTerms.JWT_ENUM.JWT_PASSPHRASE_NAME), 'utf8'),
			});
			const data = Buffer.from('synthetic payload');
			const signature = crypto.sign('sha256', data, privateKey);
			const publicKey = fs.readFileSync(keyPath(hdbTerms.JWT_ENUM.JWT_PUBLIC_KEY_NAME));
			assert.ok(crypto.verify('sha256', data, publicKey, signature));
		}

		it('writes the passphrase and private key owner-only, leaving the public key at the umask default', function () {
			checkJWTTokenExist();
			assert.strictEqual(modeOf(keyPath(hdbTerms.JWT_ENUM.JWT_PASSPHRASE_NAME)), 0o600);
			assert.strictEqual(modeOf(keyPath(hdbTerms.JWT_ENUM.JWT_PRIVATE_KEY_NAME)), 0o600);
			assert.strictEqual(modeOf(keyPath(hdbTerms.JWT_ENUM.JWT_PUBLIC_KEY_NAME)), UMASK_DEFAULT_MODE);
			assertUsableKeyPair();
		});

		it('narrows a permissive passphrase file when one missing key forces regeneration', function () {
			writeWithMode(keyPath(hdbTerms.JWT_ENUM.JWT_PASSPHRASE_NAME), 'stale', 0o664);
			writeWithMode(keyPath(hdbTerms.JWT_ENUM.JWT_PUBLIC_KEY_NAME), 'stale', 0o664);
			checkJWTTokenExist();
			assert.strictEqual(modeOf(keyPath(hdbTerms.JWT_ENUM.JWT_PASSPHRASE_NAME)), 0o600);
			assert.strictEqual(modeOf(keyPath(hdbTerms.JWT_ENUM.JWT_PRIVATE_KEY_NAME)), 0o600);
			assertUsableKeyPair();
		});
	});
});
