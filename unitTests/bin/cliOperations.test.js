'use strict';

const assert = require('node:assert');
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
const processManagementModule = require('#src/utility/processManagement/processManagement');
const configUtilsModule = require('#src/config/configUtils');

// Thrown by the mocked process.exit below so a call to it unwinds the async
// cliOperations() call (rather than actually terminating the test runner) and
// is observable via assert.rejects.
class ProcessExitSignal extends Error {
	constructor(code) {
		super(`process.exit(${code})`);
		this.code = code;
	}
}

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
		let originalScan;

		beforeEach(() => {
			saveCredentials(target, { operation_token: 'valid-token', refresh_token: 'refresh-token' });
			tokenAuthModule.isJWTExpired = () => false;
			originalPackageDirectory = packageComponentModule.packageDirectory;
			originalScan = packageComponentModule.scanPackageDirectory;
		});

		afterEach(() => {
			packageComponentModule.packageDirectory = originalPackageDirectory;
			packageComponentModule.scanPackageDirectory = originalScan;
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
			packageComponentModule.scanPackageDirectory = async () => ({
				totalSize: fakeTarball.length,
				danglingSymlinks: [],
			});
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

	describe('"Harper is not running" messaging (harper#658)', () => {
		const NOT_RUNNING_MESSAGE = 'Harper is not running. Use `harperdb run` (or `harperdb start`) to start it.';

		let originalGetHdbPid;
		let originalInitConfig;
		let originalGetConfigPath;
		let originalExit;
		let originalConsoleError;
		let consoleErrors;
		let exitCode;

		beforeEach(() => {
			originalGetHdbPid = processManagementModule.getHdbPid;
			originalInitConfig = configUtilsModule.initConfig;
			originalGetConfigPath = configUtilsModule.getConfigPath;
			originalExit = process.exit;
			originalConsoleError = console.error;

			// Pretend the local instance is running with a domain socket present on disk, so
			// the early pid/socket pre-checks pass and the failure surfaces from the actual
			// connection attempt (the httpRequest mock below), exercising the catch block
			// rather than short-circuiting on the pre-checks.
			const socketPath = path.join(testDir, 'operations-server.sock');
			fs.ensureFileSync(socketPath);
			configUtilsModule.initConfig = () => {};
			processManagementModule.getHdbPid = () => 12345;
			configUtilsModule.getConfigPath = () => socketPath;

			consoleErrors = [];
			console.error = (...args) => consoleErrors.push(args.join(' '));
			exitCode = undefined;
			process.exit = (code) => {
				exitCode = code;
				throw new ProcessExitSignal(code);
			};
		});

		afterEach(() => {
			processManagementModule.getHdbPid = originalGetHdbPid;
			configUtilsModule.initConfig = originalInitConfig;
			configUtilsModule.getConfigPath = originalGetConfigPath;
			process.exit = originalExit;
			console.error = originalConsoleError;
		});

		it('shows the friendly message (and non-zero exit) when no local pid is found', async () => {
			processManagementModule.getHdbPid = () => undefined;

			await assert.rejects(() => cliOperationsModule.cliOperations({ operation: 'status' }, true), ProcessExitSignal);

			assert.strictEqual(exitCode, 1);
			assert.ok(consoleErrors.includes(NOT_RUNNING_MESSAGE));
		});

		it('shows the friendly message (and non-zero exit) when the domain socket file is missing', async () => {
			configUtilsModule.getConfigPath = () => path.join(testDir, 'no-such-operations-server.sock');

			await assert.rejects(() => cliOperationsModule.cliOperations({ operation: 'status' }, true), ProcessExitSignal);

			assert.strictEqual(exitCode, 1);
			assert.ok(consoleErrors.includes(NOT_RUNNING_MESSAGE));
		});

		it('shows the friendly message (and non-zero exit) for a local ECONNREFUSED', async () => {
			commonUtilsModule.httpRequest = async () => {
				const err = new Error('connect ECONNREFUSED /fake/operations-server.sock');
				err.code = 'ECONNREFUSED';
				throw err;
			};

			await assert.rejects(() => cliOperationsModule.cliOperations({ operation: 'status' }, true), ProcessExitSignal);

			assert.strictEqual(exitCode, 1);
			assert.ok(consoleErrors.includes(NOT_RUNNING_MESSAGE));
			assert.ok(!consoleErrors.some((line) => line.includes('ECONNREFUSED')));
		});

		it('shows the friendly message (and non-zero exit) for a local ENOENT (stale/missing socket)', async () => {
			commonUtilsModule.httpRequest = async () => {
				const err = new Error('ENOENT: no such file or directory, connect /fake/operations-server.sock');
				err.code = 'ENOENT';
				throw err;
			};

			await assert.rejects(() => cliOperationsModule.cliOperations({ operation: 'status' }, true), ProcessExitSignal);

			assert.strictEqual(exitCode, 1);
			assert.ok(consoleErrors.includes(NOT_RUNNING_MESSAGE));
			assert.ok(!consoleErrors.some((line) => line.includes('ENOENT')));
		});

		it('keeps the detailed error (not the friendly message) for a remote-target connection failure', async () => {
			commonUtilsModule.httpRequest = async () => {
				const err = new Error('connect ECONNREFUSED 1.2.3.4:9925');
				err.code = 'ECONNREFUSED';
				throw err;
			};

			await assert.rejects(
				() => cliOperationsModule.cliOperations({ operation: 'status', target: 'example.com' }, true),
				ProcessExitSignal
			);

			assert.strictEqual(exitCode, 1);
			assert.ok(!consoleErrors.includes(NOT_RUNNING_MESSAGE));
			assert.ok(consoleErrors.some((line) => line.includes('error: Failed to connect to Harper (ECONNREFUSED)')));
		});

		it('does not crash on a throwing err.code getter, even past the connection-failure check', async () => {
			commonUtilsModule.httpRequest = async () => {
				const err = {};
				Object.defineProperty(err, 'code', {
					get() {
						throw new Error('proxy trap: code is not readable');
					},
				});
				err.message = 'should not be reachable either, since code threw first';
				throw err;
			};

			await assert.rejects(() => cliOperationsModule.cliOperations({ operation: 'status' }, true), ProcessExitSignal);

			assert.strictEqual(exitCode, 1);
			assert.ok(consoleErrors.some((line) => line.startsWith('error:')));
		});
	});

	describe('local packaging errors are not misclassified as "Harper is not running" (PR #1808)', () => {
		const NOT_RUNNING_MESSAGE = 'Harper is not running. Use `harperdb run` (or `harperdb start`) to start it.';

		let originalGetHdbPid;
		let originalInitConfig;
		let originalGetConfigPath;
		let originalScan;
		let originalStreamPackagedDirectory;
		let originalExit;
		let originalConsoleError;
		let consoleErrors;
		let exitCode;

		beforeEach(() => {
			originalGetHdbPid = processManagementModule.getHdbPid;
			originalInitConfig = configUtilsModule.initConfig;
			originalGetConfigPath = configUtilsModule.getConfigPath;
			originalScan = packageComponentModule.scanPackageDirectory;
			originalStreamPackagedDirectory = packageComponentModule.streamPackagedDirectory;
			originalExit = process.exit;
			originalConsoleError = console.error;

			// Same "Harper is running" pre-check setup as above, so the failure below comes
			// from packaging the local deploy payload, not from the pid/socket pre-checks.
			const socketPath = path.join(testDir, 'operations-server.sock');
			fs.ensureFileSync(socketPath);
			configUtilsModule.initConfig = () => {};
			processManagementModule.getHdbPid = () => 12345;
			configUtilsModule.getConfigPath = () => socketPath;

			packageComponentModule.scanPackageDirectory = async () => ({ totalSize: 0, danglingSymlinks: [] });

			consoleErrors = [];
			console.error = (...args) => consoleErrors.push(args.join(' '));
			exitCode = undefined;
			process.exit = (code) => {
				exitCode = code;
				throw new ProcessExitSignal(code);
			};
		});

		afterEach(() => {
			processManagementModule.getHdbPid = originalGetHdbPid;
			configUtilsModule.initConfig = originalInitConfig;
			configUtilsModule.getConfigPath = originalGetConfigPath;
			packageComponentModule.scanPackageDirectory = originalScan;
			packageComponentModule.streamPackagedDirectory = originalStreamPackagedDirectory;
			process.exit = originalExit;
			console.error = originalConsoleError;
		});

		it('shows a descriptive packaging error (not the friendly "not running" message) for a local deploy ENOENT from a missing file in the payload', async () => {
			// Simulates a file vanishing (or being unreadable) while tar'ing up the component
			// directory for a local `deploy_component` — an fs-level ENOENT that has nothing to
			// do with the connection to the local Harper instance.
			packageComponentModule.streamPackagedDirectory = () => {
				const err = new Error("ENOENT: no such file or directory, open '/project/missing-file.txt'");
				err.code = 'ENOENT';
				// Destroying from within _read (rather than an unconditional process.nextTick)
				// guarantees the stream already has a consumer attached — the same ordering a
				// real tar-fs/fs error arrives under, once something has started reading.
				return new Readable({
					read() {
						this.destroy(err);
					},
				});
			};

			// Mirrors the real httpRequest's contract for a streamed (multipart) body: the body
			// stream's 'error' event rejects the call — exactly the channel that must not leak a
			// raw ENOENT the catch block would otherwise mistake for a connection failure.
			commonUtilsModule.httpRequest = async (_options, data) => {
				if (data && typeof data.pipe === 'function') {
					return new Promise((resolve, reject) => {
						data.on('error', reject);
						data.on('data', () => {});
						data.on('end', () => resolve({ statusCode: 200, body: '{}' }));
					});
				}
				return { statusCode: 200, body: '{}' };
			};

			await assert.rejects(
				() => cliOperationsModule.cliOperations({ operation: 'deploy_component', project: 'widget' }, true),
				ProcessExitSignal
			);

			assert.strictEqual(exitCode, 1);
			assert.ok(
				!consoleErrors.includes(NOT_RUNNING_MESSAGE),
				`expected the packaging error not to be shown as "Harper is not running", got: ${JSON.stringify(consoleErrors)}`
			);
			assert.ok(
				consoleErrors.some((line) => line.includes('Failed to package component directory')),
				`expected a descriptive packaging error, got: ${JSON.stringify(consoleErrors)}`
			);
		});
	});

	describe('exit codes on failure', () => {
		const target = 'https://example.com:9925/';
		let originalExit;
		let originalConsoleError;
		let exitCalls;
		let consoleErrorLines;

		beforeEach(() => {
			saveCredentials(target, { operation_token: 'valid-token', refresh_token: 'refresh-token' });
			tokenAuthModule.isJWTExpired = () => false;

			exitCalls = [];
			originalExit = process.exit;
			process.exit = (code) => {
				exitCalls.push(code);
			};

			consoleErrorLines = [];
			originalConsoleError = console.error;
			console.error = (...args) => {
				consoleErrorLines.push(args.join(' '));
			};
		});

		afterEach(() => {
			process.exit = originalExit;
			console.error = originalConsoleError;
		});

		it('exits non-zero with a clear message when the request times out', async () => {
			commonUtilsModule.httpRequest = async () => {
				const err = new Error('Request timed out after 60000ms with no response from the server');
				err.code = 'ETIMEDOUT';
				throw err;
			};

			await cliOperationsModule.cliOperations({ operation: 'test', target: 'example.com' }, true);

			assert.deepStrictEqual(exitCalls, [1]);
			assert.ok(
				consoleErrorLines.some((line) => line.includes('timed out')),
				`expected a timeout message on stderr, got: ${consoleErrorLines}`
			);
		});

		it('exits non-zero on a generic connection error', async () => {
			commonUtilsModule.httpRequest = async () => {
				const err = new Error('connect ECONNREFUSED 127.0.0.1:9925');
				err.code = 'ECONNREFUSED';
				throw err;
			};

			await cliOperationsModule.cliOperations({ operation: 'test', target: 'example.com' }, true);

			assert.deepStrictEqual(exitCalls, [1]);
		});

		it('exits non-zero when the server returns a non-2xx status', async () => {
			commonUtilsModule.httpRequest = async () => ({
				statusCode: 500,
				body: JSON.stringify({ error: 'boom' }),
			});

			await cliOperationsModule.cliOperations({ operation: 'test', target: 'example.com' }, true);

			assert.deepStrictEqual(exitCalls, [1]);
		});

		it('applies a default idle-socket timeout to the request options', async () => {
			let capturedOptions;
			commonUtilsModule.httpRequest = async (options) => {
				capturedOptions = options;
				return { statusCode: 200, body: JSON.stringify({ success: true }) };
			};

			await cliOperationsModule.cliOperations({ operation: 'test', target: 'example.com' }, true);

			assert.strictEqual(typeof capturedOptions.timeout, 'number');
			assert.ok(capturedOptions.timeout > 0);
		});
	});
});
