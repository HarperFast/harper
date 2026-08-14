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

describe('deploy by reference (by_ref)', () => {
	const { prepareDeployByRef, resolveGitTarget, resolveCredentialHost, deriveGitSecretName } = cliOperationsModule;
	const GITHUB_ENV = ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_PATH'];
	let savedEnv, savedStderrWrite;

	beforeEach(() => {
		savedEnv = new Map(GITHUB_ENV.map((name) => [name, process.env[name]]));
		// The default target resolves from env, so tests that aren't about git resolution get a fixed
		// repo/SHA. The nested repo describe below overrides this to exercise git itself.
		process.env.GITHUB_REPOSITORY = 'acme/demo';
		process.env.GITHUB_SHA = 'abc123def456';
		delete process.env.GITHUB_REF;
		delete process.env.GITHUB_EVENT_PATH;
		// Silence the "Deploying … by reference" line prepareDeployByRef writes to stderr.
		savedStderrWrite = process.stderr.write;
		process.stderr.write = () => true;
	});

	afterEach(() => {
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		process.stderr.write = savedStderrWrite;
	});

	// Collects everything written to stderr while fn runs, so warnings/notes can be asserted on.
	function captureStderr(fn) {
		const written = [];
		process.stderr.write = (chunk) => {
			written.push(String(chunk));
			return true;
		};
		try {
			fn();
		} finally {
			process.stderr.write = () => true;
		}
		return written.join('');
	}

	it('builds a git+https package pinned to the resolved SHA', () => {
		const req = { by_ref: true, project: 'demo' };
		prepareDeployByRef(req);
		assert.strictEqual(req.package, 'git+https://github.com/acme/demo.git#abc123def456');
		assert.strictEqual(req.credentials, undefined); // no credential requested
	});

	// Every other CLI value is JSON-parsed, which rewrites a ref that happens to look numeric: `1.0`
	// parses to the number 1, and no amount of coercion downstream can turn that back into the tag
	// the user typed. Refs are opaque strings, so they skip the parse entirely.
	describe('ref parsing', () => {
		const { buildRequest } = cliOperationsModule;
		let savedArgv;

		beforeEach(() => {
			savedArgv = process.argv;
		});

		afterEach(() => {
			process.argv = savedArgv;
		});

		function refFromArgv(arg) {
			process.argv = ['node', 'harper', 'deploy', arg];
			return buildRequest().ref;
		}

		it('keeps a ref that looks numeric exactly as typed', () => {
			assert.strictEqual(refFromArgv('ref=1.0'), '1.0'); // not the number 1
			assert.strictEqual(refFromArgv('ref=1.10'), '1.10'); // not 1.1
			assert.strictEqual(refFromArgv('ref=1e3'), '1e3'); // not 1000
			assert.strictEqual(refFromArgv('ref=1234567'), '1234567');
		});

		it('leaves ordinary refs and other fields alone', () => {
			assert.strictEqual(refFromArgv('ref=v1.2.3'), 'v1.2.3');
			process.argv = ['node', 'harper', 'deploy', 'by_ref=true'];
			assert.strictEqual(buildRequest().by_ref, true); // still JSON-parsed
		});
	});

	// A real repo with known refs — plus a local bare repo standing in for `origin` — so ref
	// resolution is asserted against actual git behavior rather than whatever happens to exist in the
	// checkout running the tests, and without reaching the network.
	describe('ref resolution against a real repository', () => {
		const { execFileSync } = require('node:child_process');
		let rootDir, repoDir, priorCwd, headSha, remoteOnlySha, tagObjectSha;

		before(() => {
			rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-by-ref-'));
			repoDir = path.join(rootDir, 'work');
			const remoteDir = path.join(rootDir, 'remote.git');
			fs.mkdirSync(repoDir);
			const runIn = (cwd, ...args) =>
				execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
			const git = (...args) => runIn(repoDir, ...args);
			runIn(rootDir, 'init', '-q', '--bare', remoteDir);
			git('init', '-q');
			git('config', 'user.email', 'test@example.com');
			git('config', 'user.name', 'Test');
			git('commit', '-q', '--allow-empty', '-m', 'first');
			git('tag', 'v1.2.3');
			git('branch', '1234567'); // a branch name that JSON.parse turns into a number
			headSha = git('rev-parse', 'HEAD');
			git('remote', 'add', 'origin', remoteDir);
			// A commit + annotated tag that exist only on the remote: pushed from a detached HEAD, then
			// every local trace removed. This is the shallow/never-fetched case, where local resolution
			// must fail and `ls-remote` has to supply the SHA.
			git('checkout', '-q', '--detach');
			git('commit', '-q', '--allow-empty', '-m', 'second');
			remoteOnlySha = git('rev-parse', 'HEAD');
			git('tag', '-a', 'v2.0.0', '-m', 'annotated');
			tagObjectSha = git('rev-parse', 'v2.0.0'); // the tag object, not the commit it points at
			git('push', '-q', 'origin', 'HEAD:refs/heads/remote-only', 'v2.0.0');
			git('tag', '-d', 'v2.0.0');
			// A pull ref that exists both on the remote and locally, so the namespace rejection is
			// tested against a ref that would otherwise resolve on either path.
			git('push', '-q', 'origin', 'HEAD:refs/pull/42/head');
			git('update-ref', 'refs/pull/42/head', remoteOnlySha);
			git('checkout', '-q', headSha);
			// Drop the remote-tracking refs push just created, so nothing resolves locally by accident
			// (and so the "commit isn't on a remote branch" check has nothing to find).
			for (const ref of git('for-each-ref', '--format=%(refname)', 'refs/remotes').split('\n').filter(Boolean)) {
				git('update-ref', '-d', ref);
			}
			// runGit shells out against the real process cwd, so mocking process.cwd isn't enough.
			priorCwd = process.cwd();
			process.chdir(repoDir);
		});

		after(() => {
			process.chdir(priorCwd);
			fs.rmSync(rootDir, { recursive: true, force: true });
		});

		// Peers resolve the package independently, so a name that can move (a branch, or a tag
		// repointed between one peer fetching and another re-fetching after a restart) would let
		// nodes in the same cluster run different commits.
		it('resolves a local tag to its commit SHA rather than passing the name through', () => {
			assert.strictEqual(resolveGitTarget('v1.2.3').committish, headSha);
		});

		it('resolves a local branch name to its commit SHA', () => {
			assert.strictEqual(resolveGitTarget('HEAD').committish, headSha);
		});

		// prepareDeployByRef is exported and callable with a hand-built req, so a number still resolves
		// rather than being ignored — buildRequest itself no longer produces one (see below).
		it('coerces a numeric ref to a string', () => {
			assert.strictEqual(resolveGitTarget(1234567).committish, headSha);
		});

		it('an explicit ref= wins over GITHUB_SHA', () => {
			const req = { by_ref: true, ref: 'v1.2.3', project: 'demo' };
			prepareDeployByRef(req);
			assert.strictEqual(req.package, `git+https://github.com/acme/demo.git#${headSha}`);
		});

		it('resolves a ref that exists only on the remote via ls-remote', () => {
			assert.strictEqual(resolveGitTarget('remote-only').committish, remoteOnlySha);
		});

		// An annotated tag's own object ID is not a commit, so a checkout of it would fail server-side.
		it('peels a remote annotated tag to its commit, not the tag object', () => {
			assert.strictEqual(resolveGitTarget('v2.0.0').committish, remoteOnlySha);
			assert.notStrictEqual(resolveGitTarget('v2.0.0').committish, tagObjectSha);
		});

		// Failing closed is the point: passing an unresolvable name through preserved exactly the
		// divergence the SHA pin exists to prevent.
		it('fails closed when a ref resolves neither locally nor on the remote', () => {
			assert.throws(() => resolveGitTarget('no-such-ref-anywhere'), /could not resolve ref=no-such-ref-anywhere/);
		});

		// The one ref that needs no resolution — it can't move — so an unfetched full SHA still deploys.
		it('passes a full commit SHA through unresolved', () => {
			const sha = 'f'.repeat(40);
			assert.strictEqual(resolveGitTarget(sha).committish, sha);
		});

		// git parses options anywhere in its argv, so `ref=--upload-pack=<cmd>` would otherwise reach
		// `git ls-remote` as an option and run that command.
		it('rejects a ref that would be parsed as a git option', () => {
			assert.throws(() => resolveGitTarget('--upload-pack=touch /tmp/pwned'), /cannot start with "-"/);
		});

		// A plain clone fetches refs/heads/* and refs/tags/* only. A commit named through any other
		// namespace pins to an immutable SHA the cluster still can't check out — the same reachability
		// failure as the pull_request merge commit, just reached by typing it explicitly.
		describe('refs outside the cloneable namespaces', () => {
			it('rejects refs/pull/<n>/head even though it resolves both locally and on the remote', () => {
				// Guards the ordering: the namespace check runs before local resolution, so a checkout
				// that has fetched the pull ref can't quietly pin an unreachable commit.
				assert.throws(
					() => resolveGitTarget('refs/pull/42/head'),
					/outside refs\/heads\/ and refs\/tags\/[\s\S]*never check it out/
				);
			});

			it('accepts a fully-qualified branch ref', () => {
				assert.strictEqual(resolveGitTarget('refs/heads/remote-only').committish, remoteOnlySha);
			});

			it('accepts a fully-qualified tag ref, peeled to its commit', () => {
				assert.strictEqual(resolveGitTarget('refs/tags/v2.0.0').committish, remoteOnlySha);
				assert.notStrictEqual(resolveGitTarget('refs/tags/v2.0.0').committish, tagObjectSha);
			});
		});

		// The cluster clones from the remote, so an unpushed commit fails server-side with an error far
		// from the CLI. This repo's remote-tracking refs were dropped above, so nothing looks pushed.
		it('warns when the commit to deploy is on no remote branch', () => {
			delete process.env.GITHUB_SHA; // take the local-resolution path, where the check applies
			const written = captureStderr(() => prepareDeployByRef({ by_ref: true, project: 'demo' }));
			assert.match(written, /isn't on any remote branch/);
			assert.match(written, new RegExp(headSha.slice(0, 7))); // abbreviated to git's 7 characters
		});

		it('skips the push check under GITHUB_SHA, where CI is already on a pushed commit', () => {
			const written = captureStderr(() => prepareDeployByRef({ by_ref: true, project: 'demo' }));
			assert.doesNotMatch(written, /isn't on any remote branch/);
		});
	});

	// GITHUB_SHA on a pull_request run is the synthetic refs/pull/<n>/merge commit, which a plain clone
	// never fetches — deploying it fails server-side at clone time.
	describe('GitHub Actions pull_request runs', () => {
		let eventDir;

		beforeEach(() => {
			eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-by-ref-event-'));
			process.env.GITHUB_REF = 'refs/pull/42/merge';
		});

		afterEach(() => {
			fs.rmSync(eventDir, { recursive: true, force: true });
		});

		function writeEvent(payload) {
			const eventPath = path.join(eventDir, 'event.json');
			fs.writeFileSync(eventPath, JSON.stringify(payload));
			process.env.GITHUB_EVENT_PATH = eventPath;
		}

		it('deploys the pull request head commit instead of the merge commit', () => {
			writeEvent({ pull_request: { head: { sha: 'deadbeef'.repeat(5), repo: { full_name: 'acme/demo' } } } });
			const req = { by_ref: true, project: 'demo' };
			prepareDeployByRef(req);
			assert.strictEqual(req.package, `git+https://github.com/acme/demo.git#${'deadbeef'.repeat(5)}`);
		});

		// For a fork PR the head commit lives in the fork, not GITHUB_REPOSITORY — pairing the head SHA
		// with the base repo would name a commit that repo doesn't have.
		it('uses the head repository, and says so, when the pull request comes from a fork', () => {
			writeEvent({ pull_request: { head: { sha: 'abc'.repeat(13) + 'd', repo: { full_name: 'forker/demo' } } } });
			const req = { by_ref: true, project: 'demo' };
			const written = captureStderr(() => prepareDeployByRef(req));
			assert.match(req.package, /^git\+https:\/\/github\.com\/forker\/demo\.git#/);
			assert.match(written, /pull request head from forker\/demo/);
		});

		it('fails early with actionable guidance when the head cannot be read', () => {
			writeEvent({ pull_request: {} });
			assert.throws(
				() => prepareDeployByRef({ by_ref: true, project: 'demo' }),
				/synthetic merge commit[\s\S]*github\.event\.pull_request\.head\.sha/
			);
		});

		it('still honors an explicit ref= on a pull_request run', () => {
			writeEvent({ pull_request: {} }); // unreadable head, but ref= means it is never consulted
			const sha = 'a'.repeat(40);
			const req = { by_ref: true, ref: sha, project: 'demo' };
			prepareDeployByRef(req);
			assert.strictEqual(req.package, `git+https://github.com/acme/demo.git#${sha}`);
		});
	});

	describe('credential reference', () => {
		it('credential=true attaches a github.com credential reference', () => {
			const req = { by_ref: true, credential: true, project: 'demo' };
			prepareDeployByRef(req);
			assert.deepStrictEqual(req.credentials, [{ host: 'github.com', secret: 'deploy.demo.git.github.com' }]);
		});

		it('credential=github.com agrees with the package host and is accepted', () => {
			const req = { by_ref: true, credential: 'github.com', project: 'my-app' };
			prepareDeployByRef(req);
			assert.deepStrictEqual(req.credentials, [{ host: 'github.com', secret: 'deploy.my-app.git.github.com' }]);
		});

		// A credential for another host builds a reference the clone never asks for, so the private
		// deploy fails as if none were configured — reject it instead of shipping the mismatch.
		it('rejects a credential host that is not the host the package clones from', () => {
			assert.throws(
				() => prepareDeployByRef({ by_ref: true, credential: 'gitlab.com', project: 'demo' }),
				/credential=gitlab\.com doesn't match the package host github\.com/
			);
		});

		it('normalizes an explicit host before comparing it', () => {
			assert.strictEqual(resolveCredentialHost('https://GitHub.com/acme/demo', 'github.com'), 'github.com');
			assert.strictEqual(resolveCredentialHost(true, 'github.com'), 'github.com');
			assert.strictEqual(resolveCredentialHost(undefined, 'github.com'), undefined);
			assert.strictEqual(resolveCredentialHost('', 'github.com'), undefined);
		});

		it('deriveGitSecretName matches the server convention (deploy.<component>.git.<host>)', () => {
			assert.strictEqual(deriveGitSecretName('my-app', 'github.com'), 'deploy.my-app.git.github.com');
		});
	});
});
