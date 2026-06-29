'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const { Readable } = require('node:stream');
const { decode: decodeCbor } = require('cbor-x');
const { saveCredentials } = require('#src/bin/cliCredentials');
const cliOperationsModule = require('#src/bin/cliOperations');
const commonUtilsModule = require('#src/utility/common_utils');
const tokenAuthModule = require('#src/security/tokenAuthentication');
const packageComponentModule = require('#src/components/packageComponent');

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

	describe('deploy_component cross-version compatibility', () => {
		const target = 'https://example.com:9925/';
		let originalPackageDirectory;
		let originalGetSize;

		beforeEach(() => {
			saveCredentials(target, { operation_token: 'valid-token', refresh_token: 'refresh-token' });
			tokenAuthModule.isJWTExpired = () => false;
			originalPackageDirectory = packageComponentModule.packageDirectory;
			originalGetSize = packageComponentModule.getPackagedDirectorySize;
		});

		afterEach(() => {
			packageComponentModule.packageDirectory = originalPackageDirectory;
			packageComponentModule.getPackagedDirectorySize = originalGetSize;
		});

		// Streams an SSE `done` event so the modern (>= 5.1) deploy path can read its result.
		const sseDoneResponse = (result) =>
			Object.assign(Readable.from([`event: done\ndata: ${JSON.stringify({ result })}\n\n`]), {
				statusCode: 200,
				headers: { 'content-type': 'text/event-stream' },
			});

		it('downgrades a package deploy to legacy JSON when the target is < 5.1', async () => {
			const calls = [];
			commonUtilsModule.httpRequest = async (options, req) => {
				calls.push({ options, req });
				if (req.operation === 'registration_info') {
					return { statusCode: 200, body: JSON.stringify({ version: '5.0.31' }) };
				}
				return { statusCode: 200, body: JSON.stringify({ message: 'Successfully deployed', success: true }) };
			};

			const result = await cliOperationsModule.cliOperations(
				{ operation: 'deploy_component', package: '@scope/widget', project: 'widget', target: 'example.com' },
				true
			);

			// Probe first, then the deploy.
			assert.strictEqual(calls[0].req.operation, 'registration_info');
			assert.strictEqual(calls[0].options.streamResponse, undefined);
			const deploy = calls[1];
			// No streaming negotiation against the old server.
			assert.strictEqual(deploy.options.headers.Accept, undefined);
			assert.strictEqual(deploy.options.streamResponse, undefined);
			// Body is a plain JSON object, not a multipart stream, and carries no transport-only fields.
			assert.strictEqual(typeof deploy.req.pipe, 'undefined');
			assert.strictEqual(deploy.req.operation, 'deploy_component');
			assert.strictEqual(deploy.req._legacyDeploy, undefined);
			assert.strictEqual(deploy.req._multipart, undefined);
			assert.strictEqual(result.success, true);
		});

		it('downgrades a directory deploy to a CBOR binary payload when the target is < 5.1', async () => {
			const fakeTarball = Buffer.from('fake-tarball-bytes');
			packageComponentModule.getPackagedDirectorySize = async () => fakeTarball.length;
			packageComponentModule.packageDirectory = async () => fakeTarball;

			const calls = [];
			commonUtilsModule.httpRequest = async (options, req) => {
				calls.push({ options, req });
				if (req.operation === 'registration_info') {
					return { statusCode: 200, body: JSON.stringify({ version: '5.0.31' }) };
				}
				return { statusCode: 200, body: JSON.stringify({ message: 'Successfully deployed', success: true }) };
			};

			const result = await cliOperationsModule.cliOperations(
				{ operation: 'deploy_component', project: 'widget', target: 'example.com' },
				true
			);

			const deploy = calls[1];
			assert.strictEqual(deploy.options.streamResponse, undefined);
			// Multipart was abandoned in favor of a CBOR body carrying the tarball as a
			// native binary Buffer — the transport pre-5.1 servers decode directly.
			assert.strictEqual(deploy.options.headers['Content-Type'], 'application/cbor');
			assert.ok(Buffer.isBuffer(deploy.req), 'CBOR body should be a Buffer');
			const decoded = decodeCbor(deploy.req);
			assert.ok(Buffer.isBuffer(decoded.payload), 'decoded payload should be a Buffer');
			assert.strictEqual(decoded.payload.toString(), 'fake-tarball-bytes');
			assert.strictEqual(decoded.operation, 'deploy_component');
			assert.strictEqual(decoded._multipart, undefined);
			assert.strictEqual(result.success, true);
		});

		it('keeps the streaming deploy path when the target is >= 5.1', async () => {
			const calls = [];
			commonUtilsModule.httpRequest = async (options, req) => {
				calls.push({ options, req });
				if (req.operation === 'registration_info') {
					return { statusCode: 200, body: JSON.stringify({ version: '5.1.7' }) };
				}
				return sseDoneResponse({ message: 'Successfully deployed', success: true });
			};

			const result = await cliOperationsModule.cliOperations(
				{ operation: 'deploy_component', package: '@scope/widget', project: 'widget', target: 'example.com' },
				true
			);

			const deploy = calls[1];
			assert.strictEqual(deploy.options.headers.Accept, 'text/event-stream');
			assert.strictEqual(deploy.options.streamResponse, true);
			assert.strictEqual(result.success, true);
		});

		it('does not downgrade when the version probe fails (assumes modern)', async () => {
			const calls = [];
			commonUtilsModule.httpRequest = async (options, req) => {
				calls.push({ options, req });
				if (req.operation === 'registration_info') {
					return { statusCode: 404, body: 'not found' };
				}
				return sseDoneResponse({ message: 'Successfully deployed', success: true });
			};

			const result = await cliOperationsModule.cliOperations(
				{ operation: 'deploy_component', package: '@scope/widget', project: 'widget', target: 'example.com' },
				true
			);

			const deploy = calls[1];
			assert.strictEqual(deploy.options.headers.Accept, 'text/event-stream');
			assert.strictEqual(result.success, true);
		});
	});
});
