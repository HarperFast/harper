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

		it('exits non-zero with a clear message (not a bare "aborted") when an SSE deploy_component times out mid-stream', async () => {
			commonUtilsModule.httpRequest = async (options, req) => {
				if (req.operation === 'registration_info') {
					return { statusCode: 200, body: JSON.stringify({ version: '5.1.7' }) };
				}
				// Simulate the real streamed response: headers arrive and one phase event
				// flows, then the connection goes idle. httpRequest's own timeout handling
				// (common_utils.ts) destroys this response with its descriptive ETIMEDOUT
				// error — mirror that here rather than letting Node manufacture a generic
				// "aborted" error, since that manufacturing only happens on a real socket.
				let pushed = false;
				const response = new Readable({
					read() {
						if (!pushed) {
							pushed = true;
							this.push('event: phase\ndata: {"phase":"prepare"}\n\n');
							return;
						}
						const err = new Error('Request timed out after 600000ms with no response from the server');
						err.code = 'ETIMEDOUT';
						this.destroy(err);
					},
				});
				response.statusCode = 200;
				response.headers = { 'content-type': 'text/event-stream' };
				return response;
			};

			await cliOperationsModule.cliOperations(
				{ operation: 'deploy_component', package: '@scope/widget', project: 'widget', target: 'example.com' },
				true
			);

			assert.deepStrictEqual(exitCalls, [1]);
			assert.ok(
				consoleErrorLines.some((line) => line.includes('timed out')),
				`expected a timeout message on stderr, got: ${consoleErrorLines}`
			);
			assert.ok(
				!consoleErrorLines.some((line) => /^error:\s*aborted\s*$/i.test(line.trim())),
				`should not surface a bare "aborted" message, got: ${consoleErrorLines}`
			);
		});
	});

	describe('operation timeout selection', () => {
		const target = 'https://example.com:9925/';

		// Streams an SSE `done` event so the modern (>= 5.1) deploy path resolves.
		const sseDoneResponse = (result) =>
			Object.assign(Readable.from([`event: done\ndata: ${JSON.stringify({ result })}\n\n`]), {
				statusCode: 200,
				headers: { 'content-type': 'text/event-stream' },
			});

		// Forces a fresh module instance so its module-level timeout constants are recomputed
		// against the current process.env (they're only evaluated once, at first require).
		function reloadCliOperations() {
			const resolved = require.resolve('#src/bin/cliOperations');
			delete require.cache[resolved];
			return require('#src/bin/cliOperations');
		}

		beforeEach(() => {
			saveCredentials(target, { operation_token: 'valid-token', refresh_token: 'refresh-token' });
			tokenAuthModule.isJWTExpired = () => false;
		});

		it('defaults to 60000ms (60s) for non-SSE operations', async () => {
			let capturedOptions;
			commonUtilsModule.httpRequest = async (options) => {
				capturedOptions = options;
				return { statusCode: 200, body: JSON.stringify({ success: true }) };
			};

			await cliOperationsModule.cliOperations({ operation: 'test', target: 'example.com' }, true);

			assert.strictEqual(capturedOptions.timeout, 60000);
		});

		it('defaults to 600000ms (10 min) for SSE-based operations like deploy_component', async () => {
			let capturedOptions;
			commonUtilsModule.httpRequest = async (options, req) => {
				if (req.operation === 'registration_info') {
					return { statusCode: 200, body: JSON.stringify({ version: '5.1.7' }) };
				}
				capturedOptions = options;
				return sseDoneResponse({ message: 'Successfully deployed', success: true });
			};

			await cliOperationsModule.cliOperations(
				{ operation: 'deploy_component', package: '@scope/widget', project: 'widget', target: 'example.com' },
				true
			);

			assert.strictEqual(capturedOptions.timeout, 600000);
		});

		it('uses the non-SSE timeout for the streaming-deploy version probe, not the 10-minute SSE timeout', async () => {
			let probeOptions;
			commonUtilsModule.httpRequest = async (options, req) => {
				if (req.operation === 'registration_info') {
					probeOptions = options;
					return { statusCode: 200, body: JSON.stringify({ version: '5.1.7' }) };
				}
				return sseDoneResponse({ message: 'Successfully deployed', success: true });
			};

			await cliOperationsModule.cliOperations(
				{ operation: 'deploy_component', package: '@scope/widget', project: 'widget', target: 'example.com' },
				true
			);

			assert.strictEqual(probeOptions.timeout, 60000);
		});

		it('uses the non-SSE timeout for an operation-token refresh, not the 10-minute SSE timeout', async () => {
			tokenAuthModule.isJWTExpired = (token) => token === 'expired-token';
			saveCredentials(target, { operation_token: 'expired-token', refresh_token: 'refresh-token' });

			let refreshOptions;
			commonUtilsModule.httpRequest = async (options, req) => {
				if (req.operation === 'registration_info') {
					return { statusCode: 200, body: JSON.stringify({ version: '5.1.7' }) };
				}
				if (req.operation === 'refresh_operation_token') {
					refreshOptions = options;
					return { statusCode: 200, body: JSON.stringify({ operation_token: 'new-token' }) };
				}
				return sseDoneResponse({ message: 'Successfully deployed', success: true });
			};

			await cliOperationsModule.cliOperations(
				{ operation: 'deploy_component', package: '@scope/widget', project: 'widget', target: 'example.com' },
				true
			);

			assert.strictEqual(refreshOptions.timeout, 60000);
		});

		it('HARPER_CLI_TIMEOUT_MS overrides the non-SSE default', async () => {
			const originalEnv = process.env.HARPER_CLI_TIMEOUT_MS;
			process.env.HARPER_CLI_TIMEOUT_MS = '5000';
			try {
				const freshModule = reloadCliOperations();

				let capturedOptions;
				commonUtilsModule.httpRequest = async (options) => {
					capturedOptions = options;
					return { statusCode: 200, body: JSON.stringify({ success: true }) };
				};

				await freshModule.cliOperations({ operation: 'test', target: 'example.com' }, true);

				assert.strictEqual(capturedOptions.timeout, 5000);
			} finally {
				if (originalEnv === undefined) delete process.env.HARPER_CLI_TIMEOUT_MS;
				else process.env.HARPER_CLI_TIMEOUT_MS = originalEnv;
				reloadCliOperations();
			}
		});

		it('HARPER_CLI_TIMEOUT_MS overrides the SSE default too (single override for both paths)', async () => {
			const originalEnv = process.env.HARPER_CLI_TIMEOUT_MS;
			process.env.HARPER_CLI_TIMEOUT_MS = '5000';
			try {
				const freshModule = reloadCliOperations();

				let capturedOptions;
				commonUtilsModule.httpRequest = async (options, req) => {
					if (req.operation === 'registration_info') {
						return { statusCode: 200, body: JSON.stringify({ version: '5.1.7' }) };
					}
					capturedOptions = options;
					return sseDoneResponse({ message: 'Successfully deployed', success: true });
				};

				await freshModule.cliOperations(
					{ operation: 'deploy_component', package: '@scope/widget', project: 'widget', target: 'example.com' },
					true
				);

				assert.strictEqual(capturedOptions.timeout, 5000);
			} finally {
				if (originalEnv === undefined) delete process.env.HARPER_CLI_TIMEOUT_MS;
				else process.env.HARPER_CLI_TIMEOUT_MS = originalEnv;
				reloadCliOperations();
			}
		});

		it('HARPER_CLI_TIMEOUT_MS above the 32-bit setTimeout ceiling falls back to the default instead of the raw value', async () => {
			const originalEnv = process.env.HARPER_CLI_TIMEOUT_MS;
			// Exceeds 2147483647 (2^31 - 1): Node's setTimeout silently coerces values above this
			// and fires almost immediately, so out-of-range input must fall back like any other
			// invalid input rather than being passed through as the raw oversized value.
			process.env.HARPER_CLI_TIMEOUT_MS = '9999999999';
			try {
				const freshModule = reloadCliOperations();

				let capturedOptions;
				commonUtilsModule.httpRequest = async (options) => {
					capturedOptions = options;
					return { statusCode: 200, body: JSON.stringify({ success: true }) };
				};

				await freshModule.cliOperations({ operation: 'test', target: 'example.com' }, true);

				assert.strictEqual(capturedOptions.timeout, 60000);
			} finally {
				if (originalEnv === undefined) delete process.env.HARPER_CLI_TIMEOUT_MS;
				else process.env.HARPER_CLI_TIMEOUT_MS = originalEnv;
				reloadCliOperations();
			}
		});
	});

	describe('dedicated auth args vs operation payload fields (harper#1872)', () => {
		const captureRequest = () => {
			const calls = [];
			commonUtilsModule.httpRequest = async (options, body) => {
				calls.push({ options, body });
				return { statusCode: 200, body: JSON.stringify({ success: true }) };
			};
			return calls;
		};

		it('authenticates with auth_username/auth_password while add_user payload username/password stay in the body, not the auth header', async () => {
			const calls = captureRequest();

			await cliOperationsModule.cliOperations(
				{
					operation: 'add_user',
					target: 'example.com',
					auth_username: 'admin',
					auth_password: 'admin-secret',
					username: 'newuser',
					password: 'new-user-secret',
				},
				true
			);

			assert.strictEqual(calls.length, 1);
			const { options, body } = calls[0];
			assert.strictEqual(
				options.headers.Authorization,
				`Basic ${Buffer.from('admin:admin-secret').toString('base64')}`
			);
			assert.strictEqual(body.username, 'newuser');
			assert.strictEqual(body.password, 'new-user-secret');
			assert.strictEqual(body.auth_username, undefined);
			assert.strictEqual(body.auth_password, undefined);
			assert.strictEqual(body.target, undefined);
		});

		it('falls back to plain username/password as auth when no auth_username/env-var auth is configured (backward compatible)', async () => {
			const calls = captureRequest();

			await cliOperationsModule.cliOperations(
				{ operation: 'test', target: 'example.com', username: 'admin', password: 'admin-secret' },
				true
			);

			const { options } = calls[0];
			assert.strictEqual(
				options.headers.Authorization,
				`Basic ${Buffer.from('admin:admin-secret').toString('base64')}`
			);
		});

		it('prefers env-var auth over payload username/password when auth_username/auth_password are absent', async () => {
			const calls = captureRequest();
			const originalUser = process.env.HARPER_CLI_USERNAME;
			const originalPass = process.env.HARPER_CLI_PASSWORD;
			process.env.HARPER_CLI_USERNAME = 'env-admin';
			process.env.HARPER_CLI_PASSWORD = 'env-secret';
			try {
				await cliOperationsModule.cliOperations(
					{ operation: 'add_user', target: 'example.com', username: 'newuser', password: 'new-user-secret' },
					true
				);
			} finally {
				if (originalUser === undefined) delete process.env.HARPER_CLI_USERNAME;
				else process.env.HARPER_CLI_USERNAME = originalUser;
				if (originalPass === undefined) delete process.env.HARPER_CLI_PASSWORD;
				else process.env.HARPER_CLI_PASSWORD = originalPass;
			}

			const { options, body } = calls[0];
			assert.strictEqual(
				options.headers.Authorization,
				`Basic ${Buffer.from('env-admin:env-secret').toString('base64')}`
			);
			// Env-var auth wins the transport leg, but the payload fields for the user being
			// created are untouched — this is the whole point of the fix.
			assert.strictEqual(body.username, 'newuser');
			assert.strictEqual(body.password, 'new-user-secret');
		});

		it('strips auth_username/auth_password from a package deploy JSON body (the same non-multipart body path add_user uses)', async () => {
			const calls = [];
			commonUtilsModule.httpRequest = async (options, body) => {
				calls.push({ options, body });
				if (body?.operation === 'registration_info') {
					return { statusCode: 200, body: JSON.stringify({ version: '5.0.31' }) };
				}
				return { statusCode: 200, body: JSON.stringify({ message: 'Successfully deployed', success: true }) };
			};

			await cliOperationsModule.cliOperations(
				{
					operation: 'deploy_component',
					package: '@scope/widget',
					project: 'widget',
					target: 'example.com',
					auth_username: 'admin',
					auth_password: 'admin-secret',
				},
				true
			);

			assert.strictEqual(calls.length, 2);
			const deploy = calls[1];
			assert.strictEqual(
				deploy.options.headers.Authorization,
				`Basic ${Buffer.from('admin:admin-secret').toString('base64')}`
			);
			assert.strictEqual(deploy.body.auth_username, undefined);
			assert.strictEqual(deploy.body.auth_password, undefined);
		});

		it('strips auth_username/auth_password from the multipart directory-deploy body fields', async () => {
			const originalScan = packageComponentModule.scanPackageDirectory;
			const originalStream = packageComponentModule.streamPackagedDirectory;
			packageComponentModule.scanPackageDirectory = async () => ({ totalSize: 0, danglingSymlinks: [] });
			packageComponentModule.streamPackagedDirectory = () => Readable.from(Buffer.from('fake-tar-bytes'));

			const sseDoneResponse = (result) =>
				Object.assign(Readable.from([`event: done\ndata: ${JSON.stringify({ result })}\n\n`]), {
					statusCode: 200,
					headers: { 'content-type': 'text/event-stream' },
				});

			let multipartText;
			commonUtilsModule.httpRequest = async (options, body) => {
				if (body && typeof body.operation === 'string' && body.operation === 'registration_info') {
					return { statusCode: 200, body: JSON.stringify({ version: '5.1.7' }) };
				}
				// The multipart deploy body: a stream of form-data chunks, not a plain object.
				const chunks = [];
				for await (const chunk of body) chunks.push(Buffer.from(chunk));
				multipartText = Buffer.concat(chunks).toString('utf8');
				return sseDoneResponse({ message: 'Successfully deployed', success: true });
			};

			try {
				await cliOperationsModule.cliOperations(
					{
						operation: 'deploy_component',
						project: 'widget',
						target: 'example.com',
						auth_username: 'admin',
						auth_password: 'admin-secret',
					},
					true
				);
			} finally {
				packageComponentModule.scanPackageDirectory = originalScan;
				packageComponentModule.streamPackagedDirectory = originalStream;
			}

			assert.doesNotMatch(multipartText, /name="auth_username"/);
			assert.doesNotMatch(multipartText, /name="auth_password"/);
			assert.match(multipartText, /name="operation"/);
		});

		// The credentials of the user being created/altered must never outrank the caller's own
		// saved session — otherwise `harper login` + `add_user` authenticates as a user that
		// doesn't exist yet and 401s.
		for (const operation of ['add_user', 'alter_user']) {
			it(`uses the saved login token for ${operation} while its payload username/password stay in the body`, async () => {
				saveCredentials('https://example.com:9925/', {
					operation_token: 'admin-token',
					refresh_token: 'admin-refresh',
				});
				tokenAuthModule.isJWTExpired = () => false;
				const calls = captureRequest();

				await cliOperationsModule.cliOperations(
					{
						operation,
						target: 'example.com',
						username: 'newuser',
						password: 'new-user-secret',
						role: 'cluster_user',
					},
					true
				);

				const { options, body } = calls[0];
				assert.strictEqual(options.headers.Authorization, 'Bearer admin-token');
				assert.strictEqual(body.username, 'newuser');
				assert.strictEqual(body.password, 'new-user-secret');
			});
		}

		it('does not treat a lone payload username as auth (drop_user with a saved token)', async () => {
			saveCredentials('https://example.com:9925/', { operation_token: 'admin-token' });
			tokenAuthModule.isJWTExpired = () => false;
			const calls = captureRequest();

			await cliOperationsModule.cliOperations({ operation: 'drop_user', target: 'example.com', username: 'bob' }, true);

			const { options, body } = calls[0];
			assert.strictEqual(options.headers.Authorization, 'Bearer admin-token');
			assert.strictEqual(body.username, 'bob');
		});

		it('authenticates with the legacy CLI_TARGET_USERNAME/CLI_TARGET_PASSWORD pair', async () => {
			const calls = captureRequest();
			process.env.CLI_TARGET_USERNAME = 'legacy-admin';
			process.env.CLI_TARGET_PASSWORD = 'legacy-secret';
			try {
				await cliOperationsModule.cliOperations({ operation: 'test', target: 'example.com' }, true);
			} finally {
				delete process.env.CLI_TARGET_USERNAME;
				delete process.env.CLI_TARGET_PASSWORD;
			}

			assert.strictEqual(
				calls[0].options.headers.Authorization,
				`Basic ${Buffer.from('legacy-admin:legacy-secret').toString('base64')}`
			);
		});

		describe('incomplete credential sources', () => {
			let originalExit;
			let originalConsoleError;
			let consoleErrors;
			let exitCode;

			beforeEach(() => {
				originalExit = process.exit;
				originalConsoleError = console.error;
				consoleErrors = [];
				console.error = (...args) => consoleErrors.push(args.join(' '));
				exitCode = undefined;
				process.exit = (code) => {
					exitCode = code;
					throw new ProcessExitSignal(code);
				};
			});

			afterEach(() => {
				process.exit = originalExit;
				console.error = originalConsoleError;
			});

			// The dangerous shape: without pair validation, `auth_username` would be paired with
			// the *payload* password and the admin name sent with the new user's secret.
			it('fails instead of pairing auth_username with a password from another source', async () => {
				captureRequest();

				await assert.rejects(
					() =>
						cliOperationsModule.cliOperations(
							{
								operation: 'add_user',
								target: 'example.com',
								auth_username: 'admin',
								username: 'newuser',
								password: 'new-user-secret',
							},
							true
						),
					ProcessExitSignal
				);

				assert.strictEqual(exitCode, 1);
				assert.ok(consoleErrors.some((line) => line.includes('Incomplete credentials') && line.includes('username')));
			});

			it('fails on a lone auth_password', async () => {
				captureRequest();

				await assert.rejects(
					() =>
						cliOperationsModule.cliOperations(
							{ operation: 'test', target: 'example.com', auth_password: 'admin-secret' },
							true
						),
					ProcessExitSignal
				);

				assert.ok(consoleErrors.some((line) => line.includes('Incomplete credentials') && line.includes('password')));
			});

			// An empty value is "set but missing", not "unset" — a blank CI variable must not slip
			// through the way `||` let it.
			it('treats an empty auth_password as missing rather than absent', async () => {
				captureRequest();

				await assert.rejects(
					() =>
						cliOperationsModule.cliOperations(
							{ operation: 'test', target: 'example.com', auth_username: 'admin', auth_password: '' },
							true
						),
					ProcessExitSignal
				);

				assert.ok(consoleErrors.some((line) => line.includes('Incomplete credentials')));
			});

			// Unlike the args, a lone HARPER_CLI_USERNAME is a legitimate `harper login` idiom
			// (the password is prompted for), so it must not break every later operation in the
			// same shell — it is skipped, loudly, and the saved token is used instead.
			it('warns and falls through to the saved token when only one env var of a pair is set', async () => {
				saveCredentials('https://example.com:9925/', { operation_token: 'admin-token' });
				tokenAuthModule.isJWTExpired = () => false;
				const calls = captureRequest();
				process.env.HARPER_CLI_USERNAME = 'env-admin';
				delete process.env.HARPER_CLI_PASSWORD;
				try {
					await cliOperationsModule.cliOperations({ operation: 'test', target: 'example.com' }, true);
				} finally {
					delete process.env.HARPER_CLI_USERNAME;
				}

				assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer admin-token');
				assert.ok(consoleErrors.some((line) => line.includes('Ignoring incomplete credentials')));
			});

			// `auth_username=$ADMIN_USER auth_password=$ADMIN_PASS` with both CI variables unset
			// arrives as two empty strings. Falling through would run the command as whoever the
			// saved token belongs to instead of failing.
			it('fails when both dedicated auth args are supplied but empty', async () => {
				saveCredentials('https://example.com:9925/', { operation_token: 'admin-token' });
				tokenAuthModule.isJWTExpired = () => false;
				captureRequest();

				await assert.rejects(
					() =>
						cliOperationsModule.cliOperations(
							{ operation: 'test', target: 'example.com', auth_username: '', auth_password: '' },
							true
						),
					ProcessExitSignal
				);

				assert.ok(consoleErrors.some((line) => line.includes('Incomplete credentials')));
			});
		});

		it('masks a password embedded in the target URL in the connection log', async () => {
			const originalConsoleError = console.error;
			const consoleErrors = [];
			console.error = (...args) => consoleErrors.push(args.join(' '));
			const calls = captureRequest();
			try {
				await cliOperationsModule.cliOperations(
					{ operation: 'test', target: 'https://admin:url-secret@example.com:9925' },
					true
				);
			} finally {
				console.error = originalConsoleError;
			}

			// The credentials still authenticate the request; only the printed form is masked.
			assert.strictEqual(
				calls[0].options.headers.Authorization,
				`Basic ${Buffer.from('admin:url-secret').toString('base64')}`
			);
			const connecting = consoleErrors.find((line) => line.startsWith('Connecting to'));
			assert.ok(!connecting.includes('url-secret'), connecting);
			assert.ok(connecting.includes('admin:***@example.com'), connecting);
		});
	});

	describe('redactCredentials', () => {
		it('masks secret values while leaving the rest of the parsed request intact', () => {
			const redacted = cliOperationsModule.redactCredentials({
				operation: 'add_user',
				username: 'newuser',
				password: 'new-user-secret',
				auth_username: 'admin',
				auth_password: 'admin-secret',
			});

			assert.deepStrictEqual(redacted, {
				operation: 'add_user',
				username: 'newuser',
				password: '***',
				auth_username: 'admin',
				auth_password: '***',
			});
		});

		it('masks userinfo in the target URL and leaves a credential-free target alone', () => {
			assert.strictEqual(
				cliOperationsModule.redactCredentials({ target: 'https://admin:url-secret@example.com:9925/' }).target,
				'https://admin:***@example.com:9925/'
			);
			assert.strictEqual(
				cliOperationsModule.redactCredentials({ target: 'https://example.com:9925/' }).target,
				'https://example.com:9925/'
			);
		});
	});
});

describe('deploy CLI verbs (stage / activate fold into deploy_component)', () => {
	const { buildRequest, verbRequirementError } = cliOperationsModule;
	let savedArgv;
	beforeEach(() => {
		savedArgv = process.argv;
	});
	afterEach(() => {
		process.argv = savedArgv;
	});

	it('`stage` maps to deploy_component with activate:false', () => {
		process.argv = ['node', 'harper', 'stage', 'project=my_app'];
		const req = buildRequest();
		assert.strictEqual(req.operation, 'deploy_component');
		assert.strictEqual(req.activate, false);
	});

	it('`activate` with a deployment_id maps to deploy_component and passes the verb guard', () => {
		process.argv = ['node', 'harper', 'activate', 'project=my_app', 'deployment_id=abc-123'];
		const req = buildRequest();
		assert.strictEqual(req.operation, 'deploy_component');
		assert.strictEqual(req.deployment_id, 'abc-123');
		assert.strictEqual(verbRequirementError(req), null);
	});

	it('`activate` WITHOUT a deployment_id is rejected (would otherwise become a full deploy from the CWD)', () => {
		process.argv = ['node', 'harper', 'activate', 'project=my_app'];
		const req = buildRequest();
		assert.match(verbRequirementError(req), /deployment_id/);
	});

	it('verbRequirementError ignores non-activate deploys', () => {
		assert.strictEqual(verbRequirementError({ operation: 'deploy_component' }), null);
		assert.strictEqual(verbRequirementError({ operation: 'deploy_component', activate: false }), null);
	});
});
