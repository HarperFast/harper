'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const { loadCredentials, saveCredentials, clearCredentials } = require('#src/bin/cliCredentials');

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
