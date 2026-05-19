'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const { loadCredentials, saveCredentials } = require('#src/bin/cliCredentials');
const { logout } = require('#src/bin/logout');

describe('Logout command', () => {
	const testDir = path.join(os.tmpdir(), `harper-test-logout-${Date.now()}`);
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

	it('should clear all credentials on global logout', async () => {
		saveCredentials('https://example.com:9925/', {
			operation_token: 'token1',
			refresh_token: 'refresh1',
		});
		assert.ok(loadCredentials().targets['https://example.com:9925/'], 'Credentials should be loaded after saving');

		await logout();

		assert.deepStrictEqual(
			loadCredentials(),
			{ last_target: null, targets: {} },
			'Credentials should be empty after logout'
		);
	});

	it('should clear specific target', async () => {
		saveCredentials('https://cluster1.com:9925/', {
			operation_token: 'token1',
			refresh_token: 'refresh1',
		});
		saveCredentials('https://cluster2.com:9925/', {
			operation_token: 'token2',
			refresh_token: 'refresh2',
		});

		await logout('https://cluster1.com:9925/');

		const loaded = loadCredentials();
		assert.strictEqual(loaded.targets['https://cluster1.com:9925/'], undefined);
		assert.ok(loaded.targets['https://cluster2.com:9925/']);
	});
});
