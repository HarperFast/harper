'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const { loadCredentials, saveCredentials, clearCredentials, loadCliDotenv } = require('#src/bin/cliCredentials');

describe('CLI Credentials', () => {
	const testDir = path.join(os.tmpdir(), `harper-test-creds-${Date.now()}`);
	const credentialsFile = path.join(testDir, '.harperdb', 'credentials.json');
	let originalHome;

	before(() => {
		originalHome = process.env.HOME;
		process.env.HOME = testDir;
		fs.ensureDirSync(testDir);
	});

	after(() => {
		process.env.HOME = originalHome;
		fs.removeSync(testDir);
	});

	beforeEach(() => {
		fs.removeSync(credentialsFile);
	});

	it('should return empty targets when no credentials file exists', () => {
		const creds = loadCredentials();
		assert.deepStrictEqual(creds, { last_target: null, targets: {} });
	});

	it('should save and load credentials with target', () => {
		const target = 'https://example.com:9925/';
		const tokens = {
			operation_token: 'op-token-123',
			refresh_token: 'ref-token-456',
		};
		saveCredentials(target, tokens);

		const loaded = loadCredentials();
		assert.ok(loaded);
		assert.strictEqual(loaded.last_target, 'https://example.com:9925/');
		assert.ok(loaded.targets['https://example.com:9925/']);
		assert.strictEqual(loaded.targets['https://example.com:9925/'].operation_token, 'op-token-123');
	});

	it('should support multiple targets', () => {
		saveCredentials('https://cluster1.com:9925/', {
			operation_token: 'token1',
			refresh_token: 'refresh1',
		});
		saveCredentials('https://cluster2.com:9925/', {
			operation_token: 'token2',
			refresh_token: 'refresh2',
		});

		const loaded = loadCredentials();
		assert.strictEqual(loaded.last_target, 'https://cluster2.com:9925/');
		assert.strictEqual(loaded.targets['https://cluster1.com:9925/'].operation_token, 'token1');
		assert.strictEqual(loaded.targets['https://cluster2.com:9925/'].operation_token, 'token2');
	});

	it('should clear specific target', () => {
		saveCredentials('https://cluster1.com:9925/', {
			operation_token: 'token1',
			refresh_token: 'refresh1',
		});
		saveCredentials('https://cluster2.com:9925/', {
			operation_token: 'token2',
			refresh_token: 'refresh2',
		});

		clearCredentials('https://cluster1.com:9925/');
		const loaded = loadCredentials();
		assert.strictEqual(loaded.targets['https://cluster1.com:9925/'], undefined);
		assert.ok(loaded.targets['https://cluster2.com:9925/']);
		assert.strictEqual(loaded.last_target, 'https://cluster2.com:9925/');
	});

	it('should clear all credentials when no target provided', () => {
		saveCredentials('https://cluster1.com:9925/', {
			operation_token: 'token1',
			refresh_token: 'refresh1',
		});

		clearCredentials();
		assert.deepStrictEqual(loadCredentials(), { last_target: null, targets: {} });
		assert.strictEqual(fs.existsSync(credentialsFile), false);
	});
	it('should normalize target with trailing slash when saving and clearing', () => {
		saveCredentials('https://no-slash.com:9925', {
			operation_token: 'token-no-slash',
			refresh_token: 'refresh-no-slash',
		});

		const loaded = loadCredentials();
		assert.strictEqual(loaded.last_target, 'https://no-slash.com:9925/');
		assert.ok(loaded.targets['https://no-slash.com:9925/']);
		assert.strictEqual(loaded.targets['https://no-slash.com:9925/'].operation_token, 'token-no-slash');

		clearCredentials('https://no-slash.com:9925');
		const loadedAfterClear = loadCredentials();
		assert.strictEqual(loadedAfterClear.targets['https://no-slash.com:9925/'], undefined);
	});
});

describe('loadCliDotenv', () => {
	const projectDir = path.join(os.tmpdir(), `harper-test-cli-dotenv-${Date.now()}`);
	const guardedKeys = [
		'HARPER_CLI_TARGET',
		'CLI_TARGET',
		'HARPER_CLI_USERNAME',
		'HARPER_CLI_PASSWORD',
		'HARPER_CLI_OPERATION_TOKEN',
		'HARPER_CLI_REFRESH_TOKEN',
		'CLI_TARGET_USERNAME',
		'CLI_TARGET_PASSWORD',
		'CLI_TARGET_OPERATION_TOKEN',
		'CLI_TARGET_REFRESH_TOKEN',
		'ACTIONS_ID_TOKEN_REQUEST_URL',
		'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
		'GITHUB_REPOSITORY',
		'GITHUB_SHA',
		'GITHUB_REF',
		'GITHUB_EVENT_PATH',
		'HOME',
		'USERPROFILE',
		'NODE_TLS_REJECT_UNAUTHORIZED',
		'NODE_EXTRA_CA_CERTS',
		'SSL_CERT_FILE',
		'SSL_CERT_DIR',
		'NODE_USE_ENV_PROXY',
		'HTTP_PROXY',
		'HTTPS_PROXY',
		'NO_PROXY',
	];
	const touchedKeys = [...guardedKeys, 'harper_cli_target', 'https_proxy', 'SAFE_SETTING', 'OTHER_SETTING', 'GIT_DIR'];
	const savedEnv = {};
	let originalCwd;

	function writeEnv(content) {
		fs.writeFileSync(path.join(projectDir, '.env'), content);
	}

	before(() => {
		fs.ensureDirSync(projectDir);
		originalCwd = process.cwd;
		process.cwd = () => projectDir;
		for (const key of touchedKeys) savedEnv[key] = process.env[key];
	});

	after(() => {
		process.cwd = originalCwd;
		fs.removeSync(projectDir);
	});

	beforeEach(() => {
		for (const key of touchedKeys) delete process.env[key];
		fs.removeSync(path.join(projectDir, '.env'));
	});

	afterEach(() => {
		for (const key of touchedKeys) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	for (const key of guardedKeys) {
		it(`refuses ${key} supplied by the project .env, naming the key but not its value`, () => {
			writeEnv(`SAFE_SETTING=loaded\n${key}=sentinel-secret-value\n`);
			assert.throws(loadCliDotenv, (error) => {
				assert.strictEqual(error.statusCode, 400);
				assert.ok(error.message.includes(key), error.message);
				assert.ok(!error.message.includes('sentinel-secret-value'), error.message);
				return true;
			});
			assert.strictEqual(process.env[key], undefined);
			assert.strictEqual(process.env.SAFE_SETTING, undefined);
		});
	}

	// Windows environment names are case-insensitive, so `harper_cli_target` IS `HARPER_CLI_TARGET`
	// there; Node also reads lowercase proxy variables on every platform.
	for (const key of ['harper_cli_target', 'https_proxy']) {
		it(`refuses the lowercase spelling ${key}`, () => {
			writeEnv(`${key}=https://attacker.example\n`);
			assert.throws(loadCliDotenv, /must not come from/);
		});
	}

	it('refuses a lowercase spelling even when the upper-case name is inherited', () => {
		process.env.HTTPS_PROXY = 'http://inherited.example:8080';
		writeEnv('https_proxy=http://attacker.example:8080\n');
		assert.throws(loadCliDotenv, /https_proxy/);
		assert.strictEqual(process.env.https_proxy, undefined);
	});

	// Child processes (git, gh, npm) honour an open set of variables; the guard covers only what the CLI reads.
	it('applies settings only a child process reads, and none of them beside a refused key', () => {
		writeEnv('GIT_DIR=/elsewhere\nHARPER_CLI_TARGET=https://attacker.example\n');
		assert.throws(loadCliDotenv, /HARPER_CLI_TARGET/);
		assert.strictEqual(process.env.GIT_DIR, undefined);

		writeEnv('GIT_DIR=/elsewhere\n');
		loadCliDotenv();
		assert.strictEqual(process.env.GIT_DIR, '/elsewhere');
	});

	it('refuses export-prefixed and duplicated assignments', () => {
		writeEnv('export HARPER_CLI_TARGET=https://a.example\nHARPER_CLI_TARGET=https://b.example\n');
		assert.throws(loadCliDotenv, /HARPER_CLI_TARGET/);
	});

	it('lists every refused key in one error', () => {
		writeEnv('HARPER_CLI_TARGET=https://a.example\nHARPER_CLI_PASSWORD=pw\n');
		assert.throws(loadCliDotenv, (error) => {
			assert.ok(error.message.includes('HARPER_CLI_TARGET, HARPER_CLI_PASSWORD'), error.message);
			return true;
		});
	});

	it('accepts a guarded key the inherited environment already sets, and keeps the inherited value', () => {
		process.env.HARPER_CLI_TARGET = 'https://exported.example:9925/';
		writeEnv('HARPER_CLI_TARGET=https://project.example\nSAFE_SETTING=loaded\n');
		loadCliDotenv();
		assert.strictEqual(process.env.HARPER_CLI_TARGET, 'https://exported.example:9925/');
		assert.strictEqual(process.env.SAFE_SETTING, 'loaded');
	});

	it('loads other keys without overriding inherited values, and is repeatable', () => {
		process.env.OTHER_SETTING = 'inherited';
		writeEnv('SAFE_SETTING=loaded\nOTHER_SETTING=from-file\n');
		loadCliDotenv();
		loadCliDotenv();
		assert.strictEqual(process.env.SAFE_SETTING, 'loaded');
		assert.strictEqual(process.env.OTHER_SETTING, 'inherited');
	});

	it('does nothing when there is no .env', () => {
		loadCliDotenv();
		assert.strictEqual(process.env.SAFE_SETTING, undefined);
	});
});
