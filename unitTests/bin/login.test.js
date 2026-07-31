'use strict';

const assert = require('node:assert');
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

		// A normalized target keys the credentials file, is echoed in status output, written to .env
		// and emitted by `harper login --for-ci`. Userinfo riding along would put the password in all
		// four, so it is dropped here rather than at each of those sites.
		it('should strip embedded credentials', () => {
			assert.strictEqual(normalizeTarget('https://admin:hunter2@example.com:9925'), 'https://example.com:9925/');
			assert.strictEqual(normalizeTarget('admin@example.com:1234'), 'https://example.com:1234/');
		});

		// The default port is applied by looking for a `:` in the authority, which the `:` in
		// `user:password` used to satisfy — so a userinfo target came out port-less and resolved to
		// 443 instead of 9925.
		it('should still apply the default port when credentials contain a colon', () => {
			assert.strictEqual(normalizeTarget('https://admin:hunter2@example.com'), 'https://example.com:9925/');
		});

		it('should preserve an explicitly written default port', () => {
			assert.strictEqual(normalizeTarget('https://example.com:443'), 'https://example.com:443/');
			assert.strictEqual(normalizeTarget('http://example.com:80'), 'http://example.com:80/');
		});

		// login normalizes, then cliOperations normalizes again. `URL` serializes a default port away,
		// so without writing it back the second pass would read `https://host:443` as port-less and
		// append 9925 — silently sending the request somewhere else than the user asked for.
		it('should be idempotent', () => {
			for (const target of [
				'example.com',
				'https://example.com:443',
				'http://example.com:80',
				'https://admin:hunter2@example.com',
				'example.com:1234',
				'example.com/api',
			]) {
				const once = normalizeTarget(target);
				assert.strictEqual(normalizeTarget(once), once, target);
			}
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

	describe('credential sources', () => {
		const testDir = path.join(os.tmpdir(), `harper-test-login-creds-${Date.now()}`);
		const cliOperationsModule = require('#src/bin/cliOperations');
		let originalCwd;
		let originalExit;
		let originalStdoutWrite;
		let originalPrompt;
		let originalCliOperations;
		let loginRequest;

		before(() => {
			fs.mkdirSync(testDir, { recursive: true });
			originalCwd = process.cwd;
			process.cwd = () => testDir;
			originalExit = process.exit;
			process.exit = (code) => {
				if (code !== 0) throw new Error('process.exit:' + code);
			};
			originalStdoutWrite = process.stdout.write;
			process.stdout.write = () => {};
			originalPrompt = inquirer.prompt;
			inquirer.prompt = async (questions) => {
				const q = Array.isArray(questions) ? questions[0] : questions;
				return { [q.name]: `prompted-${q.name}` };
			};
			originalCliOperations = cliOperationsModule.cliOperations;
			cliOperationsModule.cliOperations = async (req) => {
				loginRequest = req;
				return { operation_token: 'mock-token', refresh_token: 'mock-refresh', target: req.target };
			};
		});

		after(() => {
			process.cwd = originalCwd;
			process.exit = originalExit;
			process.stdout.write = originalStdoutWrite;
			inquirer.prompt = originalPrompt;
			cliOperationsModule.cliOperations = originalCliOperations;
			fs.rmSync(testDir, { recursive: true, force: true });
		});

		beforeEach(() => {
			loginRequest = undefined;
			for (const name of [
				'CLI_TARGET',
				'HARPER_CLI_TARGET',
				'CLI_TARGET_USERNAME',
				'CLI_TARGET_PASSWORD',
				'HARPER_CLI_USERNAME',
				'HARPER_CLI_PASSWORD',
			]) {
				delete process.env[name];
			}
			fs.rmSync(path.join(testDir, '.env'), { force: true });
		});

		// Mixing namespaces would log in as one identity using another identity's secret.
		it('never pairs a username from one env namespace with a password from the other', async () => {
			process.env.HARPER_CLI_USERNAME = 'harper-admin';
			process.env.CLI_TARGET_PASSWORD = 'legacy-secret';

			await login('example.com');

			assert.strictEqual(loginRequest.username, 'harper-admin');
			assert.strictEqual(loginRequest.password, 'prompted-password');
		});

		it('uses the CLI_TARGET_* pair when it is the only namespace set', async () => {
			process.env.CLI_TARGET_USERNAME = 'legacy-admin';
			process.env.CLI_TARGET_PASSWORD = 'legacy-secret';

			await login('example.com');

			assert.strictEqual(loginRequest.username, 'legacy-admin');
			assert.strictEqual(loginRequest.password, 'legacy-secret');
		});

		// Login's credentials ARE the caller's credentials, so they must ride as dedicated
		// transport auth — otherwise a re-login after expiry tries to refresh the very token it is
		// replacing and exits with "please run harper login".
		it('sends the credentials as dedicated transport auth as well as payload fields', async () => {
			process.env.HARPER_CLI_USERNAME = 'harper-admin';
			process.env.HARPER_CLI_PASSWORD = 'harper-secret';

			await login('example.com');

			assert.strictEqual(loginRequest.auth_username, 'harper-admin');
			assert.strictEqual(loginRequest.auth_password, 'harper-secret');
			assert.strictEqual(loginRequest.username, 'harper-admin');
			assert.strictEqual(loginRequest.password, 'harper-secret');
		});
	});

	// `harper login --for-ci` is meant to be piped (`| gh secret set --env-file -`, `| pbcopy`), so
	// what matters is not just that the credentials are printed but WHICH stream each byte lands
	// on: anything besides the dotenv block on stdout corrupts the pipe, and a token on stderr
	// defeats the point of keeping it off the screen.
	describe('CI/CD environment variable output (--for-ci)', () => {
		const testDir = path.join(os.tmpdir(), `harper-test-login-cicd-${Date.now()}`);
		const cliOperationsModule = require('#src/bin/cliOperations');
		let originalCwd;
		let originalHome;
		let originalExit;
		let originalPrompt;
		let originalConsoleLog;
		let originalStdoutWrite;
		let originalStderrWrite;
		let originalCliOperations;
		let originalIsTty;
		let stdout;
		let stderr;
		let refreshToken;

		before(() => {
			fs.mkdirSync(testDir, { recursive: true });
			originalCwd = process.cwd;
			process.cwd = () => testDir;

			// Keep saveCredentials off the developer's real ~/.harperdb/credentials.json.
			originalHome = process.env.HOME;
			process.env.HOME = testDir;

			originalExit = process.exit;
			process.exit = (code) => {
				if (code !== 0) throw new Error('process.exit:' + code);
			};

			originalPrompt = inquirer.prompt;
			inquirer.prompt = async (questions) => {
				const q = Array.isArray(questions) ? questions[0] : questions;
				return { [q.name]: 'mock-response' };
			};

			originalCliOperations = cliOperationsModule.cliOperations;
			cliOperationsModule.cliOperations = async (req) => {
				if (req.operation === 'create_authentication_tokens') {
					return { operation_token: 'op-tok', refresh_token: refreshToken, target: req.target };
				}
				return {};
			};
		});

		after(() => {
			process.cwd = originalCwd;
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			process.exit = originalExit;
			inquirer.prompt = originalPrompt;
			cliOperationsModule.cliOperations = originalCliOperations;
			fs.rmSync(testDir, { recursive: true, force: true });
		});

		beforeEach(() => {
			stdout = [];
			stderr = [];
			refreshToken = 'ref-tok';
			// Password from env so login needs no interactive prompt.
			process.env.HARPER_CLI_PASSWORD = 'password';
			// Non-TTY by default: the dedicated-CI-user confirmation only fires when there is a human
			// to ask, and these cases assert the unattended (runner) path.
			originalIsTty = process.stdin.isTTY;
			process.stdin.isTTY = false;
		});

		afterEach(() => {
			delete process.env.HARPER_CLI_PASSWORD;
			delete process.env.HARPER_CLI_TARGET;
			delete process.env.CLI_TARGET;
			process.stdin.isTTY = originalIsTty;
		});

		// Captures the streams only for the duration of the call — leaving them patched would also
		// swallow mocha's own reporter output and mix it into these assertions.
		async function captureLogin(...args) {
			originalStdoutWrite = process.stdout.write;
			originalStderrWrite = process.stderr.write;
			originalConsoleLog = console.log;
			process.stdout.write = (chunk) => {
				stdout.push(String(chunk));
				return true;
			};
			process.stderr.write = (chunk) => {
				stderr.push(String(chunk));
				return true;
			};
			// console.log is bound to the original stdout, so patch it too — otherwise a stray
			// console.log would print for real and escape the "stdout is only the dotenv block" check.
			console.log = (...parts) => {
				stdout.push(`${parts.join(' ')}\n`);
			};
			try {
				return await login(...args);
			} finally {
				process.stdout.write = originalStdoutWrite;
				process.stderr.write = originalStderrWrite;
				console.log = originalConsoleLog;
			}
		}

		it('writes nothing but the dotenv block to stdout, so it can be piped', async () => {
			await captureLogin('example.com', 'mockuser', { forCi: true });

			// Exactly two lines, both KEY=value — `gh secret set --env-file -` reads this verbatim.
			const lines = stdout
				.join('')
				.split('\n')
				.filter((line) => line.length > 0);
			assert.deepStrictEqual(lines, [
				'HARPER_CLI_TARGET=https://example.com:9925/',
				'HARPER_CLI_REFRESH_TOKEN=ref-tok',
			]);
			// The short-lived operation token is intentionally not emitted — the refresh token is
			// the single durable secret; the CLI mints an operation token from it on each run.
			assert.ok(!stdout.join('').includes('HARPER_CLI_OPERATION_TOKEN'), stdout.join(''));
		});

		it('keeps the banner and status messages on stderr, away from the pipe', async () => {
			await captureLogin('example.com', 'mockuser', { forCi: true });

			const err = stderr.join('');
			assert.ok(err.includes('Harper login'), err);
			assert.ok(err.includes('Successfully logged in'), err);
			// The token must never be duplicated onto stderr — keeping it off the screen is the
			// whole reason for piping.
			assert.ok(!err.includes('ref-tok'), err);
		});

		// A target given with embedded credentials must not put the password anywhere the resolved
		// target goes. Sanitizing only the emitted line would still leave it on the terminal, in
		// ~/.harperdb/credentials.json and in .env — so the strip happens once, in normalizeTarget,
		// and this asserts every one of those destinations.
		it('keeps credentials embedded in the target URL out of stdout, stderr, and everything persisted', async () => {
			fs.writeFileSync(path.join(testDir, '.env'), 'EXISTING=1\n');
			await captureLogin('https://admin:hunter2@example.com', 'mockuser', { forCi: true });

			const out = stdout.join('');
			assert.ok(out.includes('HARPER_CLI_TARGET=https://example.com:9925/'), out);

			const err = stderr.join('');
			const credentialsFile = fs.readFileSync(path.join(testDir, '.harperdb', 'credentials.json'), 'utf8');
			const envFile = fs.readFileSync(path.join(testDir, '.env'), 'utf8');
			for (const [name, contents] of [
				['stdout', out],
				['stderr', err],
				['credentials.json', credentialsFile],
				['.env', envFile],
			]) {
				assert.ok(!contents.includes('hunter2'), `${name} leaked the password: ${contents}`);
				assert.ok(!contents.includes('admin@'), `${name} leaked the username: ${contents}`);
			}
			// The credentials-file key and the emitted target are the same value, so a later
			// `harper deploy` against the emitted target finds the entry this login wrote.
			assert.ok(JSON.parse(credentialsFile).targets['https://example.com:9925/'], credentialsFile);
			fs.rmSync(path.join(testDir, '.env'), { force: true });
		});

		// Harper stores one refresh-token hash per user, so this credential is a rotation, not an
		// addition: any refresh token the user already held is now dead. That is invisible until some
		// other holder's next refresh 401s, so the command has to say it out loud.
		it("warns on stderr that the user's previous refresh token was revoked", async () => {
			await captureLogin('example.com', 'ci-deploy', { forCi: true });

			const err = stderr.join('');
			assert.ok(err.includes('One refresh token per user'), err);
			assert.ok(err.includes("'ci-deploy'"), err);
			assert.ok(err.includes('Give each CI consumer its own user'), err);
			// The warning is human-facing, so it must not disturb the pipe.
			const lines = stdout
				.join('')
				.split('\n')
				.filter((line) => line.length > 0);
			assert.deepStrictEqual(lines, [
				'HARPER_CLI_TARGET=https://example.com:9925/',
				'HARPER_CLI_REFRESH_TOKEN=ref-tok',
			]);
		});

		it('does not warn about rotation on a default login, which mints nothing durable for CI', async () => {
			await captureLogin('example.com', 'mockuser');

			assert.ok(!stderr.join('').includes('One refresh token per user'), stderr.join(''));
		});

		// The CLI cannot verify that a user is dedicated to CI, but it can refuse to rotate that
		// user's only refresh token without someone saying yes.
		describe('dedicated-CI-user confirmation (interactive)', () => {
			let originalCreatePromptModule;
			let confirmAnswer;
			let confirmMessage;

			beforeEach(() => {
				process.stdin.isTTY = true;
				confirmMessage = undefined;
				originalCreatePromptModule = inquirer.createPromptModule;
				inquirer.createPromptModule = () => async (questions) => {
					const q = Array.isArray(questions) ? questions[0] : questions;
					if (q.type === 'confirm') {
						confirmMessage = q.message;
						return { [q.name]: confirmAnswer };
					}
					return { [q.name]: 'mock-response' };
				};
			});

			afterEach(() => {
				inquirer.createPromptModule = originalCreatePromptModule;
			});

			it('names the user and proceeds when confirmed', async () => {
				confirmAnswer = true;
				await captureLogin('example.com', 'ci-deploy', { forCi: true });

				assert.ok(confirmMessage.includes("'ci-deploy'"), confirmMessage);
				assert.ok(confirmMessage.includes('revokes any refresh token it already holds'), confirmMessage);
				assert.ok(stdout.join('').includes('HARPER_CLI_REFRESH_TOKEN=ref-tok'), stdout.join(''));
			});

			it('exits without minting anything when declined', async () => {
				confirmAnswer = false;

				await assert.rejects(() => captureLogin('example.com', 'ci-deploy', { forCi: true }), /process\.exit:1/);
				assert.strictEqual(stdout.join(''), '');
			});
		});

		it('prints nothing at all without the flag (default login is unchanged)', async () => {
			await captureLogin('example.com', 'mockuser');

			const out = stdout.join('');
			assert.ok(!out.includes('HARPER_CLI_REFRESH_TOKEN='), out);
			assert.ok(!out.includes('ref-tok'), out);
		});

		// A silent empty stdout would be piped into a secret store and "succeed" at storing nothing.
		it('fails loudly when the cluster returns no refresh token', async () => {
			refreshToken = undefined;

			await assert.rejects(() => captureLogin('example.com', 'mockuser', { forCi: true }), /process\.exit:1/);
			assert.ok(!stdout.join('').includes('HARPER_CLI_TARGET='), stdout.join(''));
		});
	});
});
