'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { login } = require('#src/bin/login');
const { normalizeTarget } = require('#src/bin/cliCredentials');

describe('Login', () => {
	describe('url normalization', () => {
		it('should add https:// and port 9925 to a domain', () => {
			assert.strictEqual(normalizeTarget('example.com'), 'https://example.com:9925/');
		});

		it('should add port 9925 if missing but protocol is present', () => {
			assert.strictEqual(normalizeTarget('http://example.com'), 'http://example.com:9925/');
			assert.strictEqual(normalizeTarget('https://example.com'), 'https://example.com:9925/');
		});

		it('should preserve existing port', () => {
			assert.strictEqual(normalizeTarget('example.com:1234'), 'https://example.com:1234/');
			assert.strictEqual(normalizeTarget('http://example.com:1234'), 'http://example.com:1234/');
		});

		it('should add trailing slash', () => {
			assert.strictEqual(normalizeTarget('https://example.com:9925'), 'https://example.com:9925/');
		});

		it('should handle IP addresses', () => {
			assert.strictEqual(normalizeTarget('127.0.0.1'), 'https://127.0.0.1:9925/');
		});

		it('should handle localhost', () => {
			assert.strictEqual(normalizeTarget('localhost'), 'https://localhost:9925/');
		});

		it('should handle existing paths', () => {
			assert.strictEqual(normalizeTarget('example.com/api'), 'https://example.com:9925/api/');
		});
	});

	describe('function arguments', () => {
		const readline = require('node:readline/promises');
		let originalCreateInterface;
		let questionCalls;

		beforeEach(() => {
			questionCalls = [];
			process.env.CLI_TARGET_PASSWORD = 'mockpassword';
			originalCreateInterface = readline.createInterface;
			readline.createInterface = () => {
				return {
					question: async (query) => {
						questionCalls.push(query);
						if (query.includes('Username')) return 'mockuser';
						return 'mock-response';
					},
					close: () => {},
				};
			};

			this.originalExit = process.exit;
			process.exit = (code) => {
				throw new Error('process.exit:' + code);
			};
		});

		afterEach(() => {
			delete process.env.CLI_TARGET_PASSWORD;
			readline.createInterface = originalCreateInterface;
			process.exit = this.originalExit;
		});

		it('should NOT prompt for target when targetArg is provided', async () => {
			try {
				await login('cluster.example.com');
			} catch {
				// Ignore errors after target check
			}
			const targetPrompted = questionCalls.some((q) => q.includes('Target'));
			assert.strictEqual(targetPrompted, false, 'Should not have prompted for target');
		});
	});

	describe('.env modifications', () => {
		const testDir = path.join(os.tmpdir(), `harper-test-env-${Date.now()}`);
		let originalCwd;
		let originalExit;
		let originalStdoutWrite;
		let originalStdinSetRawMode;
		let originalStdinResume;
		let originalStdinPause;
		let originalStdinOn;
		let originalStdinRemoveListener;

		// Mock cliOperations
		const cliOperationsModule = require('#src/bin/cliOperations');
		let originalCliOperations;

		before(() => {
			if (!fs.existsSync(testDir)) {
				fs.mkdirSync(testDir, { recursive: true });
			}
			originalCwd = process.cwd;
			process.cwd = () => testDir;

			originalExit = process.exit;
			process.exit = (code) => {
				if (code !== 0) {
					throw new Error('process.exit:' + code);
				}
			};

			originalStdoutWrite = process.stdout.write;
			process.stdout.write = () => {};

			originalStdinSetRawMode = process.stdin.setRawMode;
			process.stdin.setRawMode = () => {};
			originalStdinResume = process.stdin.resume;
			process.stdin.resume = () => {};
			originalStdinPause = process.stdin.pause;
			process.stdin.pause = () => {};
			originalStdinOn = process.stdin.on;
			process.stdin.on = () => {};
			originalStdinRemoveListener = process.stdin.removeListener;
			process.stdin.removeListener = () => {};

			originalCliOperations = cliOperationsModule.cliOperations;
			cliOperationsModule.cliOperations = async (req) => {
				if (req.operation === 'create_authentication_tokens') {
					return {
						operation_token: 'mock-token',
						refresh_token: 'mock-refresh',
						target: req.target,
					};
				}
				return {};
			};
		});

		after(() => {
			process.cwd = originalCwd;
			process.exit = originalExit;
			process.stdout.write = originalStdoutWrite;
			process.stdin.setRawMode = originalStdinSetRawMode;
			process.stdin.resume = originalStdinResume;
			process.stdin.pause = originalStdinPause;
			process.stdin.on = originalStdinOn;
			process.stdin.removeListener = originalStdinRemoveListener;
			cliOperationsModule.cliOperations = originalCliOperations;
			fs.rmSync(testDir, { recursive: true, force: true });
		});

		beforeEach(() => {
			const envPath = path.join(testDir, '.env');
			if (fs.existsSync(envPath)) {
				fs.unlinkSync(envPath);
			}
			// Clear relevant env vars
			delete process.env.CLI_TARGET;
			delete process.env.HARPER_CLI_TARGET;
			delete process.env.CLI_TARGET_PASSWORD;
			delete process.env.HARPER_CLI_PASSWORD;
			delete process.env.CLI_TARGET_USERNAME;
			delete process.env.HARPER_CLI_USERNAME;
		});

		it('should append HARPER_CLI_TARGET with a leading newline if .env does not end with one', async () => {
			const envPath = path.join(testDir, '.env');
			fs.writeFileSync(envPath, 'EXISTING_VAR=value'); // No trailing newline

			// Set password in env to avoid readline/stdin issues
			process.env.HARPER_CLI_PASSWORD = 'password';

			// We need to mock readline.createInterface because login uses it
			const readline = require('node:readline/promises');
			const originalCreateInterface = readline.createInterface;
			readline.createInterface = () => ({
				question: async () => 'mockuser',
				close: () => {},
			});

			try {
				await login('example.com', 'mockuser');
			} finally {
				readline.createInterface = originalCreateInterface;
			}

			const envContent = fs.readFileSync(envPath, 'utf8');
			// The fix added `\nHARPER_CLI_TARGET=${resolvedTarget}\n`
			// So it should be `EXISTING_VAR=value\nHARPER_CLI_TARGET=https://example.com:9925/\n`
			assert.strictEqual(envContent, 'EXISTING_VAR=value\nHARPER_CLI_TARGET=https://example.com:9925/\n');
		});

		it('should append HARPER_CLI_TARGET normally if .env ends with a newline', async () => {
			const envPath = path.join(testDir, '.env');
			fs.writeFileSync(envPath, 'EXISTING_VAR=value\n'); // Has trailing newline

			process.env.HARPER_CLI_PASSWORD = 'password';

			const readline = require('node:readline/promises');
			const originalCreateInterface = readline.createInterface;
			readline.createInterface = () => ({
				question: async () => 'mockuser',
				close: () => {},
			});

			try {
				await login('example.com', 'mockuser');
			} finally {
				readline.createInterface = originalCreateInterface;
			}

			const envContent = fs.readFileSync(envPath, 'utf8');
			// It will result in `EXISTING_VAR=value\n\nHARPER_CLI_TARGET=https://example.com:9925/\n`
			// This is acceptable as it ensures the new entry is on its own line.
			assert.strictEqual(envContent, 'EXISTING_VAR=value\n\nHARPER_CLI_TARGET=https://example.com:9925/\n');
		});
	});
});
