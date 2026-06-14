'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { login } = require('#src/bin/login');
const { normalizeTarget } = require('#src/bin/cliCredentials');
const inquirer = require('inquirer');

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
		let originalPrompt;
		let promptCalls;

		beforeEach(() => {
			promptCalls = [];
			process.env.CLI_TARGET_PASSWORD = 'mockpassword';
			originalPrompt = inquirer.prompt;
			inquirer.prompt = async (questions) => {
				const q = Array.isArray(questions) ? questions[0] : questions;
				promptCalls.push(q);
				if (q.name === 'username') return { username: 'mockuser' };
				if (q.name === 'target') return { target: 'mock-target' };
				return { [q.name]: 'mock-response' };
			};

			this.originalExit = process.exit;
			process.exit = (code) => {
				throw new Error('process.exit:' + code);
			};
		});

		afterEach(() => {
			delete process.env.CLI_TARGET_PASSWORD;
			inquirer.prompt = originalPrompt;
			process.exit = this.originalExit;
		});

		it('should NOT prompt for target when targetArg is provided', async () => {
			try {
				await login('cluster.example.com');
			} catch {
				// Ignore errors after target check
			}
			const targetPrompted = promptCalls.some((q) => q.name === 'target');
			assert.strictEqual(targetPrompted, false, 'Should not have prompted for target');
		});
	});

	describe('.env modifications', () => {
		const testDir = path.join(os.tmpdir(), `harper-test-env-${Date.now()}`);
		let originalCwd;
		let originalExit;
		let originalStdoutWrite;

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

			// Both targetArg and usernameArg are provided, password from env — inquirer is never called.
			process.env.HARPER_CLI_PASSWORD = 'password';
			await login('example.com', 'mockuser');

			const envContent = fs.readFileSync(envPath, 'utf8');
			// The fix added `\nHARPER_CLI_TARGET=${resolvedTarget}\n`
			// So it should be `EXISTING_VAR=value\nHARPER_CLI_TARGET=https://example.com:9925/\n`
			assert.strictEqual(envContent, 'EXISTING_VAR=value\nHARPER_CLI_TARGET=https://example.com:9925/\n');
		});

		it('should append HARPER_CLI_TARGET normally if .env ends with a newline', async () => {
			const envPath = path.join(testDir, '.env');
			fs.writeFileSync(envPath, 'EXISTING_VAR=value\n'); // Has trailing newline

			process.env.HARPER_CLI_PASSWORD = 'password';
			await login('example.com', 'mockuser');

			const envContent = fs.readFileSync(envPath, 'utf8');
			// It will result in `EXISTING_VAR=value\n\nHARPER_CLI_TARGET=https://example.com:9925/\n`
			// This is acceptable as it ensures the new entry is on its own line.
			assert.strictEqual(envContent, 'EXISTING_VAR=value\n\nHARPER_CLI_TARGET=https://example.com:9925/\n');
		});
	});
});
