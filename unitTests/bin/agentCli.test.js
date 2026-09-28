'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('fs-extra');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { saveCredentials } = require('#src/bin/cliCredentials');
const { runAgentCli } = require('#src/bin/agentCli');
const commonUtilsModule = require('#src/utility/common_utils');
const tokenAuthModule = require('#src/security/tokenAuthentication');
const processManagementModule = require('#src/utility/processManagement/processManagement');
const configUtilsModule = require('#src/config/configUtils');
const terms = require('#src/utility/hdbTerms');
const { HOME_ENV_KEYS } = require('../bootPropsFixture');

const ENV_KEYS = [
	'HARPER_CLI_TARGET',
	'CLI_TARGET',
	'HARPER_CLI_USERNAME',
	'CLI_TARGET_USERNAME',
	'HARPER_CLI_PASSWORD',
	'CLI_TARGET_PASSWORD',
];

function basic(username, password) {
	return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

const completedSession = {
	status: 'completed',
	messages: [
		{ role: 'user', content: 'the prompt' },
		{ role: 'assistant', content: 'done', toolCalls: [{ name: 'create_table', arguments: { table: 'Product' } }] },
		{ role: 'tool', content: 'created' },
	],
};

// Running out of answers closes it the way Ctrl-D does, with the last question still pending.
function scriptedReadline(answers) {
	const rl = new EventEmitter();
	rl.questions = [];
	rl.closed = false;
	rl.question = (query, callback) => {
		rl.questions.push(query);
		if (answers.length) {
			const answer = answers.shift();
			setImmediate(() => callback(answer));
		} else setImmediate(() => rl.close());
	};
	rl.close = () => {
		if (rl.closed) return;
		rl.closed = true;
		rl.emit('close');
	};
	return rl;
}

describe('agentCli (harper agent)', function () {
	// .mocharc sets no timeout; a regression in any hang guard below must fail rather than stall the run.
	this.timeout(10000);

	const testDir = path.join(os.tmpdir(), `harper-test-agent-cli-${process.pid}-${Date.now()}`);
	const originals = {};
	let savedEnv;
	let requests;
	let createdInterfaces;
	let nextReadline;

	before(() => {
		originals.homeEnv = Object.fromEntries(HOME_ENV_KEYS.map((key) => [key, process.env[key]]));
		originals.log = console.log;
		originals.error = console.error;
		originals.httpRequest = commonUtilsModule.httpRequest;
		originals.isJWTExpired = tokenAuthModule.isJWTExpired;
		originals.getHdbPid = processManagementModule.getHdbPid;
		originals.initConfig = configUtilsModule.initConfig;
		originals.getConfigPath = configUtilsModule.getConfigPath;
		originals.createInterface = readline.createInterface;
		originals.stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
		for (const key of HOME_ENV_KEYS) process.env[key] = testDir;
	});

	after(() => {
		for (const [key, value] of Object.entries(originals.homeEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		commonUtilsModule.httpRequest = originals.httpRequest;
		tokenAuthModule.isJWTExpired = originals.isJWTExpired;
		processManagementModule.getHdbPid = originals.getHdbPid;
		configUtilsModule.initConfig = originals.initConfig;
		configUtilsModule.getConfigPath = originals.getConfigPath;
		readline.createInterface = originals.createInterface;
		Object.defineProperty(process, 'stdin', originals.stdin);
		fs.removeSync(testDir);
	});

	beforeEach(() => {
		fs.removeSync(testDir);
		fs.ensureDirSync(testDir);
		savedEnv = {};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tokenAuthModule.isJWTExpired = () => false;
		processManagementModule.getHdbPid = () => {
			throw new Error('unexpected local-instance lookup');
		};
		configUtilsModule.initConfig = () => {};
		configUtilsModule.getConfigPath = () => {
			throw new Error('unexpected config lookup');
		};
		createdInterfaces = [];
		nextReadline = null;
		readline.createInterface = (options) => {
			createdInterfaces.push(options);
			if (!nextReadline) throw new Error('unexpected readline.createInterface');
			return nextReadline;
		};
		setStdin({ isTTY: false });
		serve(() => [200, completedSession]);
	});

	afterEach(() => {
		// run() restores these itself unless a hung runAgentCli was abandoned by the test timeout.
		console.log = originals.log;
		console.error = originals.error;
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	function setStdin({ isTTY, content = '' }) {
		const stdin = new PassThrough();
		stdin.isTTY = isTTY;
		stdin.end(content);
		Object.defineProperty(process, 'stdin', { value: stdin, configurable: true, writable: true });
		return stdin;
	}

	function serve(sessionFor, { promptResponse = () => [200, { session_id: 'session-1' }] } = {}) {
		requests = [];
		let polls = 0;
		commonUtilsModule.httpRequest = async (options, body) => {
			requests.push({ options: { ...options, headers: { ...options.headers } }, body });
			let response;
			if (body.operation === 'get_agent_session') response = sessionFor(++polls);
			else if (body.operation === 'agent_prompt') response = promptResponse(body);
			else response = [200, {}];
			const [statusCode, payload] = response;
			return { statusCode, body: typeof payload === 'string' ? payload : JSON.stringify(payload) };
		};
	}

	const operations = () => requests.map((request) => request.body.operation);
	const firstRequest = (operation) => requests.find((request) => request.body.operation === operation);
	const allRequests = (operation) => requests.filter((request) => request.body.operation === operation);

	async function run(...argv) {
		const out = [];
		const err = [];
		console.log = (...args) => out.push(args.join(' '));
		console.error = (...args) => err.push(args.join(' '));
		try {
			const code = await runAgentCli(argv);
			return { code, out: out.join('\n'), err: err.join('\n') };
		} finally {
			console.log = originals.log;
			console.error = originals.error;
		}
	}

	describe('argument parsing', () => {
		it('--help and -h print usage without connecting', async () => {
			for (const flag of ['--help', '-h']) {
				const result = await run('a message', flag);
				assert.strictEqual(result.code, 0, result.err);
				assert.match(result.out, /^harper agent — interact with the built-in Harper agent/);
				assert.deepStrictEqual(requests, [], `${flag} must not reach the server`);
			}
		});

		it('joins positional words into one message and drops unknown dash flags', async () => {
			process.env.HARPER_CLI_USERNAME = 'admin';
			const result = await run('build', '--target', 'agent.example', 'a', '-v', 'Product', '--verbose', 'table');
			assert.strictEqual(result.code, 0, result.err);
			assert.strictEqual(firstRequest('agent_prompt').body.message, 'build a Product table');
		});

		it('--session and --session= resume the given session', async () => {
			process.env.HARPER_CLI_USERNAME = 'admin';
			for (const argv of [['--session', 'existing-1'], ['--session=existing-1']]) {
				serve(() => [200, completedSession]);
				const result = await run('--target', 'agent.example', ...argv, 'hi');
				assert.strictEqual(result.code, 0, result.err);
				assert.strictEqual(firstRequest('agent_prompt').body.session_id, 'existing-1');
				assert.strictEqual(firstRequest('get_agent_session').body.session_id, 'existing-1');
			}
		});

		it('starts a new session when none is given and polls the id the server assigned', async () => {
			process.env.HARPER_CLI_USERNAME = 'admin';
			const result = await run('--target', 'agent.example', 'hi');
			assert.strictEqual(result.code, 0, result.err);
			assert.ok(!('session_id' in firstRequest('agent_prompt').body));
			assert.strictEqual(firstRequest('get_agent_session').body.session_id, 'session-1');
		});

		it('--target= and the --user/--pass aliases set the connection', async () => {
			const result = await run('--target=agent.example:7000', '--user', 'alias-user', '--pass', 'alias-pass', 'hi');
			assert.strictEqual(result.code, 0, result.err);
			const { options } = firstRequest('agent_prompt');
			assert.strictEqual(options.hostname, 'agent.example');
			assert.strictEqual(options.port, '7000');
			assert.strictEqual(options.headers.Authorization, basic('alias-user', 'alias-pass'));
		});

		it('renders the transcript delta after the sent prompt, or the raw session with --json', async () => {
			process.env.HARPER_CLI_USERNAME = 'admin';
			const rendered = await run('--target', 'agent.example', 'hi');
			assert.strictEqual(rendered.code, 0, rendered.err);
			assert.match(rendered.out, /agent › done/);
			assert.match(rendered.out, /▸ create_table\(\{"table":"Product"\}\)/);
			assert.match(rendered.out, /⤷ created/);
			assert.doesNotMatch(rendered.out, /the prompt/, 'user messages are not rendered');

			const json = await run('--target', 'agent.example', '--json', 'hi');
			assert.strictEqual(json.code, 0, json.err);
			assert.deepStrictEqual(JSON.parse(json.out), completedSession);
		});
	});

	describe('connection resolution', () => {
		describe('target', () => {
			beforeEach(() => {
				process.env.HARPER_CLI_USERNAME = 'admin';
				saveCredentials('stored.example', { operation_token: 'stored-token', refresh_token: 'stored-refresh' });
				process.env.HARPER_CLI_TARGET = 'env.example';
				process.env.CLI_TARGET = 'legacy-env.example';
			});

			const targetHost = async (...argv) => {
				const result = await run(...argv, 'hi');
				assert.strictEqual(result.code, 0, result.err);
				return firstRequest('agent_prompt').options.hostname;
			};

			it('--target beats every other source', async () => {
				assert.strictEqual(await targetHost('--target', 'flag.example'), 'flag.example');
			});

			it('HARPER_CLI_TARGET beats CLI_TARGET and the stored last target', async () => {
				assert.strictEqual(await targetHost(), 'env.example');
			});

			it('CLI_TARGET beats the stored last target', async () => {
				delete process.env.HARPER_CLI_TARGET;
				assert.strictEqual(await targetHost(), 'legacy-env.example');
			});

			it('falls back to the last `harper login` target and its stored token', async () => {
				delete process.env.HARPER_CLI_TARGET;
				delete process.env.CLI_TARGET;
				assert.strictEqual(await targetHost(), 'stored.example');
				assert.strictEqual(firstRequest('agent_prompt').options.headers.Authorization, 'Bearer stored-token');
			});
		});

		it('normalizes a bare host to https on port 9925, and keeps an explicit scheme and port', async () => {
			process.env.HARPER_CLI_USERNAME = 'admin';
			await run('--target', 'agent.example', 'hi');
			let { options } = firstRequest('agent_prompt');
			assert.deepStrictEqual([options.protocol, options.hostname, options.port], ['https:', 'agent.example', '9925']);
			assert.strictEqual(options.method, 'POST');

			serve(() => [200, completedSession]);
			await run('--target', 'http://agent.example:8080', 'hi');
			({ options } = firstRequest('agent_prompt'));
			assert.deepStrictEqual([options.protocol, options.hostname, options.port], ['http:', 'agent.example', '8080']);
		});

		describe('credentials', () => {
			const authorization = async (...argv) => {
				const result = await run(...argv, 'hi');
				assert.strictEqual(result.code, 0, result.err);
				return firstRequest('agent_prompt').options.headers.Authorization;
			};

			beforeEach(() => {
				process.env.HARPER_CLI_USERNAME = 'env-user';
				process.env.HARPER_CLI_PASSWORD = 'env-pass';
				process.env.CLI_TARGET_USERNAME = 'legacy-user';
				process.env.CLI_TARGET_PASSWORD = 'legacy-pass';
			});

			it('flags beat target userinfo and env', async () => {
				assert.strictEqual(
					await authorization(
						'--target',
						'https://url-user:url-pass@agent.example',
						'--username',
						'flag-user',
						'--password',
						'flag-pass'
					),
					basic('flag-user', 'flag-pass')
				);
			});

			it('each field falls back independently', async () => {
				assert.strictEqual(
					await authorization('--target', 'https://url-user:url-pass@agent.example', '--username', 'flag-user'),
					basic('flag-user', 'url-pass')
				);
			});

			it('target userinfo beats env, and is not sent as part of the URL', async () => {
				assert.strictEqual(
					await authorization('--target', 'https://url-user:url-pass@agent.example'),
					basic('url-user', 'url-pass')
				);
				assert.strictEqual(firstRequest('agent_prompt').options.hostname, 'agent.example');
			});

			it('HARPER_CLI_* beats CLI_TARGET_*', async () => {
				assert.strictEqual(await authorization('--target', 'agent.example'), basic('env-user', 'env-pass'));
			});

			it('CLI_TARGET_* is the last credential source', async () => {
				delete process.env.HARPER_CLI_USERNAME;
				delete process.env.HARPER_CLI_PASSWORD;
				assert.strictEqual(await authorization('--target', 'agent.example'), basic('legacy-user', 'legacy-pass'));
			});

			describe('with a stored token for the target', () => {
				beforeEach(() => {
					// Stored under the normalized key; a bare `--target agent.example` must find it.
					saveCredentials('agent.example', { operation_token: 'stored-token', refresh_token: 'stored-refresh' });
				});

				it('explicit flags still win', async () => {
					assert.strictEqual(
						await authorization('--target', 'agent.example', '--username', 'flag-user', '--password', 'flag-pass'),
						basic('flag-user', 'flag-pass')
					);
				});

				it('target userinfo still wins', async () => {
					assert.strictEqual(
						await authorization('--target', 'https://url-user:url-pass@agent.example'),
						basic('url-user', 'url-pass')
					);
				});

				it('the stored token beats env credentials', async () => {
					assert.strictEqual(await authorization('--target', 'agent.example'), 'Bearer stored-token');
				});

				it('an expired stored token is refreshed before it is used', async () => {
					tokenAuthModule.isJWTExpired = (token) => token === 'stored-token';
					const baseHandler = commonUtilsModule.httpRequest;
					commonUtilsModule.httpRequest = async (options, body) => {
						if (body.operation !== 'refresh_operation_token') return baseHandler(options, body);
						requests.push({ options: { ...options, headers: { ...options.headers } }, body });
						return { statusCode: 200, body: JSON.stringify({ operation_token: 'fresh-token' }) };
					};
					const result = await run('--target', 'agent.example', 'hi');
					assert.strictEqual(result.code, 0, result.err);
					assert.deepStrictEqual(operations().slice(0, 2), ['refresh_operation_token', 'agent_prompt']);
					const refresh = firstRequest('refresh_operation_token');
					assert.strictEqual(refresh.options.hostname, 'agent.example');
					assert.strictEqual(refresh.options.headers.Authorization, 'Bearer stored-refresh');
					assert.strictEqual(firstRequest('agent_prompt').options.headers.Authorization, 'Bearer fresh-token');
				});
			});
		});

		it('fails with a login hint, before any request, when a remote target has no credentials', async () => {
			const result = await run('--target', 'agent.example', 'hi');
			assert.strictEqual(result.code, 1);
			assert.match(
				result.err,
				/No credentials for https:\/\/agent\.example:9925\/\. Run `harper login https:\/\/agent\.example:9925\/`/
			);
			assert.deepStrictEqual(requests, []);
		});

		describe('local instance (no target anywhere)', () => {
			let initConfigCalls;
			let configPathParams;
			let socketPath;

			beforeEach(() => {
				initConfigCalls = 0;
				configPathParams = [];
				socketPath = path.join(testDir, 'operations-server');
				configUtilsModule.initConfig = () => initConfigCalls++;
				configUtilsModule.getConfigPath = (param) => {
					configPathParams.push(param);
					return socketPath;
				};
				processManagementModule.getHdbPid = () => 4242;
			});

			it('uses the operations domain socket', async () => {
				const result = await run('hi');
				assert.strictEqual(result.code, 0, result.err);
				assert.strictEqual(initConfigCalls, 1);
				assert.deepStrictEqual(configPathParams, [terms.CONFIG_PARAMS.OPERATIONSAPI_NETWORK_DOMAINSOCKET]);
				const { options } = firstRequest('agent_prompt');
				assert.strictEqual(options.socketPath, socketPath);
				assert.strictEqual(options.protocol, 'http:');
				assert.strictEqual(options.hostname, undefined);
				assert.strictEqual(options.headers.Authorization, undefined);
			});

			it('fails when no local instance is running', async () => {
				processManagementModule.getHdbPid = () => undefined;
				const result = await run('hi');
				assert.strictEqual(result.code, 1);
				assert.match(result.err, /Harper must be running to use the agent/);
				assert.deepStrictEqual(requests, []);
			});

			it('fails when the instance has no operations socket configured', async () => {
				socketPath = undefined;
				const result = await run('hi');
				assert.strictEqual(result.code, 1);
				assert.match(result.err, /No operations domain socket configured/);
				assert.deepStrictEqual(requests, []);
			});
		});
	});

	describe('operation errors', () => {
		beforeEach(() => {
			process.env.HARPER_CLI_USERNAME = 'admin';
		});

		it('surfaces the server error message for an HTTP error status', async () => {
			serve(() => [200, completedSession], { promptResponse: () => [403, { error: 'super user required' }] });
			const result = await run('--target', 'agent.example', 'hi');
			assert.strictEqual(result.code, 1);
			assert.match(result.err, /^agent: super user required$/m);
			assert.deepStrictEqual(operations(), ['agent_prompt']);
		});

		it('reports a non-JSON response with its status', async () => {
			serve(() => [200, completedSession], { promptResponse: () => [502, '<html>Bad Gateway</html>'] });
			const result = await run('--target', 'agent.example', 'hi');
			assert.strictEqual(result.code, 1);
			assert.match(result.err, /Non-JSON response \(HTTP 502\): <html>Bad Gateway<\/html>/);
		});
	});

	describe('tool approvals', () => {
		const awaitingApproval = {
			status: 'awaiting_approval',
			messages: [{ role: 'user', content: 'the prompt' }],
			pendingApprovals: [
				{ id: 'approval-old', toolName: 'drop_table', arguments: {}, reason: 'destructive', resolved: true },
				{ id: 'approval-1', toolName: 'deploy_component', arguments: { project: 'app' }, reason: 'writes code' },
			],
		};

		beforeEach(() => {
			process.env.HARPER_CLI_USERNAME = 'admin';
			serve((poll) => [200, poll === 1 ? awaitingApproval : completedSession]);
		});

		const approvals = () => allRequests('approve_agent_action').map((request) => request.body);

		it('fails instead of hanging when stdin is not a terminal', async () => {
			setStdin({ isTTY: false });
			const result = await run('--target', 'agent.example', 'deploy it');
			assert.strictEqual(result.code, 1);
			assert.match(result.err, /Tool approval required, but no interactive terminal is available/);
			assert.deepStrictEqual(createdInterfaces, []);
			assert.deepStrictEqual(approvals(), []);
		});

		it('fails instead of hanging when --once already drained a terminal stdin', async () => {
			setStdin({ isTTY: true, content: 'deploy it\n' });
			const result = await run('--target', 'agent.example', '--once');
			assert.strictEqual(result.code, 1);
			assert.strictEqual(firstRequest('agent_prompt').body.message, 'deploy it');
			assert.match(result.err, /Tool approval required, but no interactive terminal is available/);
			assert.deepStrictEqual(createdInterfaces, []);
			assert.deepStrictEqual(approvals(), []);
		});

		it('neither prompts nor trips the terminal guard when nothing is left to approve', async () => {
			setStdin({ isTTY: false });
			const allResolved = { ...awaitingApproval, pendingApprovals: [awaitingApproval.pendingApprovals[0]] };
			serve(() => [200, allResolved]);
			const result = await run('--target', 'agent.example', 'deploy it');
			assert.doesNotMatch(result.err, /Tool approval required/);
			assert.deepStrictEqual(operations(), ['agent_prompt', 'get_agent_session']);
			assert.deepStrictEqual(createdInterfaces, []);
		});

		it('prompts on a terminal in one-shot mode, submits the decision, closes its readline, and resumes', async () => {
			const stdin = setStdin({ isTTY: true });
			nextReadline = scriptedReadline(['y']);
			const result = await run('--target', 'agent.example', 'deploy it');
			assert.strictEqual(result.code, 0, result.err);
			assert.strictEqual(createdInterfaces.length, 1);
			assert.strictEqual(createdInterfaces[0].input, stdin);
			assert.strictEqual(nextReadline.questions.length, 1, 'only the unresolved approval is asked about');
			assert.match(result.out, /approval required: deploy_component\(\{"project":"app"\}\) {2}\[reason: writes code\]/);
			assert.deepStrictEqual(approvals(), [
				{ operation: 'approve_agent_action', session_id: 'session-1', approval_id: 'approval-1', approved: true },
			]);
			assert.ok(nextReadline.closed);
			assert.deepStrictEqual(operations(), [
				'agent_prompt',
				'get_agent_session',
				'approve_agent_action',
				'get_agent_session',
			]);
			assert.match(result.out, /agent › done/);
		});

		it('treats anything but y/yes as a denial', async () => {
			for (const answer of ['n', '', 'sure', 'YES']) {
				serve((poll) => [200, poll === 1 ? awaitingApproval : completedSession]);
				setStdin({ isTTY: true });
				nextReadline = scriptedReadline([answer]);
				const result = await run('--target', 'agent.example', 'deploy it');
				assert.strictEqual(result.code, 0, result.err);
				assert.strictEqual(approvals()[0].approved, answer === 'YES', `answer ${JSON.stringify(answer)}`);
			}
		});

		it('in the REPL, asks on the REPL readline rather than opening a second one', async () => {
			setStdin({ isTTY: true });
			nextReadline = scriptedReadline(['deploy it', 'yes']);
			const result = await run('--target', 'agent.example');
			assert.strictEqual(result.code, 0, result.err);
			assert.strictEqual(createdInterfaces.length, 1);
			assert.deepStrictEqual(
				approvals().map((approval) => approval.approved),
				[true]
			);
		});
	});

	describe('interactive REPL', () => {
		beforeEach(() => {
			process.env.HARPER_CLI_USERNAME = 'admin';
			setStdin({ isTTY: true });
		});

		it('keeps one session across turns, /new starts another, and EOF exits cleanly', async () => {
			let sessions = 0;
			serve(() => [200, completedSession], { promptResponse: () => [200, { session_id: `session-${++sessions}` }] });
			nextReadline = scriptedReadline(['first', '', 'second', '/new', 'third']);
			const result = await run('--target', 'https://url-user:secret-pass@agent.example');
			assert.strictEqual(result.code, 0, result.err);
			assert.deepStrictEqual(
				allRequests('agent_prompt').map((request) => [request.body.message, request.body.session_id]),
				[
					['first', undefined],
					['second', 'session-1'],
					['third', undefined],
				]
			);
			assert.match(result.err, /Connected to https:\/\/agent\.example:9925\/\./);
			assert.doesNotMatch(result.err, /secret-pass/);
			assert.ok(nextReadline.closed);
		});

		it('reports a failed turn and keeps the session running', async () => {
			let prompts = 0;
			serve(() => [200, completedSession], {
				promptResponse: () =>
					++prompts === 1 ? [500, { error: 'model unavailable' }] : [200, { session_id: 'session-1' }],
			});
			nextReadline = scriptedReadline(['first', 'second', '/exit']);
			const result = await run('--target', 'agent.example');
			assert.strictEqual(result.code, 0, result.err);
			assert.match(result.err, /agent: model unavailable/);
			assert.deepStrictEqual(
				allRequests('agent_prompt').map((request) => request.body.message),
				['first', 'second']
			);
			assert.strictEqual(nextReadline.questions.length, 3, '/exit ends the loop without waiting for EOF');
		});
	});
});
