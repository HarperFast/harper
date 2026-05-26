'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const { saveCredentials } = require('#src/bin/cliCredentials');
const cliOperationsModule = require('#src/bin/cliOperations');
const commonUtilsModule = require('#src/utility/common_utils');
const tokenAuthModule = require('#src/security/tokenAuthentication');

describe('cliOperations', () => {
	const testDir = path.join(os.tmpdir(), `harper-test-cli-ops-${Date.now()}`);
	let originalHome;
	let originalHttpRequest;
	let originalIsJWTExpired;

	before(() => {
		originalHome = process.env.HOME;
		process.env.HOME = testDir;
		fs.ensureDirSync(testDir);

		originalHttpRequest = commonUtilsModule.httpRequest;
		originalIsJWTExpired = tokenAuthModule.isJWTExpired;
	});

	after(() => {
		process.env.HOME = originalHome;
		fs.removeSync(testDir);

		commonUtilsModule.httpRequest = originalHttpRequest;
		tokenAuthModule.isJWTExpired = originalIsJWTExpired;
	});

	beforeEach(() => {
		fs.removeSync(path.join(testDir, '.harperdb'));
		fs.ensureDirSync(testDir);
	});

	it('Leg 1: should use non-expired token directly', async () => {
		const target = 'https://example.com:9925/';
		saveCredentials(target, {
			operation_token: 'valid-token',
			refresh_token: 'refresh-token',
		});

		tokenAuthModule.isJWTExpired = () => false;

		let httpRequestCalled = false;
		commonUtilsModule.httpRequest = async (options, _req) => {
			httpRequestCalled = true;
			assert.strictEqual(options.headers.Authorization, 'Bearer valid-token');
			return { statusCode: 200, body: JSON.stringify({ success: true }) };
		};

		const result = await cliOperationsModule.cliOperations({ operation: 'test', target: 'example.com' }, true);
		assert.strictEqual(httpRequestCalled, true);
		assert.strictEqual(result.success, true);
	});

	it('Leg 2: should refresh expired token and save it', async () => {
		const target = 'https://example.com:9925/';
		saveCredentials(target, {
			operation_token: 'expired-token',
			refresh_token: 'refresh-token',
		});

		tokenAuthModule.isJWTExpired = (token) => token === 'expired-token';

		let httpRequestCalls = [];
		commonUtilsModule.httpRequest = async (options, req) => {
			httpRequestCalls.push({ options, req });
			if (req.operation === 'refresh_operation_token') {
				assert.strictEqual(options.headers.Authorization, 'Bearer refresh-token');
				return {
					statusCode: 200,
					body: JSON.stringify({ operation_token: 'new-token' }),
				};
			}
			return { statusCode: 200, body: JSON.stringify({ success: true }) };
		};

		const result = await cliOperationsModule.cliOperations({ operation: 'test', target: 'example.com' }, true);

		// Verify refresh call
		assert.strictEqual(httpRequestCalls.length, 2);
		assert.strictEqual(httpRequestCalls[0].req.operation, 'refresh_operation_token');

		// Verify original request with new token
		assert.strictEqual(httpRequestCalls[1].options.headers.Authorization, 'Bearer new-token');
		assert.strictEqual(result.success, true);

		// Verify new token was saved to disk by reloading credentials
		const { loadCredentials } = require('#src/bin/cliCredentials');
		const creds = loadCredentials();
		assert.strictEqual(creds.targets[target].operation_token, 'new-token');
	});
});
