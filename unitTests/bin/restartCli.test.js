'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');

const RESTART_MESSAGE = 'Restarting Harper. This may take up to 60 seconds.';
// The Operations API wraps the restart operation's string result this way.
const RESTART_REPLY = { message: RESTART_MESSAGE };
const CHILD_TIMEOUT_MS = 60000;

function runCli(env, cwd, ...args) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				...process.execArgv.filter((arg) => arg.startsWith('--conditions=')),
				require.resolve('#src/bin/harper'),
				'restart',
				...args,
			],
			{ cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }
		);
		let output = '';
		child.stdout.on('data', (chunk) => (output += chunk));
		child.stderr.on('data', (chunk) => (output += chunk));
		const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
		child.on('error', reject);
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, output });
		});
	});
}

// Answers with `reply`, or never answers when it is null.
function operationsServer(reply) {
	const requests = [];
	const server = http.createServer((request, response) => {
		let body = '';
		request.on('data', (chunk) => (body += chunk));
		request.on('end', () => {
			requests.push(JSON.parse(body));
			if (!reply) return;
			response.writeHead(reply.statusCode, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify(reply.body));
		});
	});
	return { server, requests };
}

function listen(server, ...args) {
	return new Promise((resolve) => server.listen(...args, resolve));
}

describe('harper restart from the CLI (harper#4299)', function () {
	let temp;
	let env;
	let socketPath;
	let pidFile;
	let servers;

	beforeEach(() => {
		// Short, so the socket path stays under the platform's sun_path limit.
		temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-'));
		const root = path.join(temp, 'root');
		const home = path.join(temp, 'home');
		for (const dir of ['database', 'log', 'keys', 'components'])
			fs.mkdirSync(path.join(root, dir), { recursive: true });
		fs.mkdirSync(home);
		socketPath = path.join(temp, 'ops.sock');
		pidFile = path.join(root, 'hdb.pid');
		const config = YAML.parse(fs.readFileSync(path.join(__dirname, '../../static/defaultConfig.yaml'), 'utf8'));
		config.rootPath = root;
		config.operationsApi.network.domainSocket = socketPath;
		config.operationsApi.network.port = config.operationsApi.network.securePort = null;
		config.http.port = config.http.securePort = null;
		fs.writeFileSync(path.join(root, 'harper-config.yaml'), YAML.stringify(config));
		env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (/^(HARPER_|HDB_|CLI_|STORAGE_|ROOTPATH$|DEFAULTS_MODE$)/.test(key)) delete env[key];
		}
		Object.assign(env, { ROOTPATH: root, HOME: home, USERPROFILE: home });
		servers = [];
	});

	afterEach(async () => {
		await Promise.all(
			servers.map((server) => {
				server.closeAllConnections();
				return new Promise((resolve) => server.close(resolve));
			})
		);
		fs.rmSync(temp, { recursive: true, force: true });
	});

	// The CLI process's own pid is never reported as running, so a running Harper is stood in for
	// by this test process: alive, and not the CLI.
	function markRunning() {
		fs.writeFileSync(pidFile, String(process.pid));
	}

	it('asks a running Harper to restart over its domain socket instead of starting another', async () => {
		markRunning();
		const { server, requests } = operationsServer({ statusCode: 200, body: RESTART_REPLY });
		servers.push(server);
		await listen(server, socketPath);
		// Neither a target from the environment nor a saved login moves a bare `harper restart` off this machine.
		env.HARPER_CLI_TARGET = 'https://remote.invalid:9925';
		const credentialsDir = path.join(env.HOME, '.harperdb');
		fs.mkdirSync(credentialsDir);
		fs.writeFileSync(
			path.join(credentialsDir, 'credentials.json'),
			JSON.stringify({ last_target: 'https://saved.invalid:9925', targets: {} })
		);

		const { code, output } = await runCli(env, temp);

		assert.strictEqual(code, 0, output);
		assert.deepStrictEqual(requests, [{ operation: 'restart' }], output);
		assert(output.includes(`message: ${RESTART_MESSAGE}`), output);
		assert.doesNotMatch(output, /already running|Starting Harper/, output);
	});

	it('exits non-zero, without claiming a restart, when the running Harper refuses it', async () => {
		markRunning();
		const { server, requests } = operationsServer({ statusCode: 500, body: { error: 'refused for the test' } });
		servers.push(server);
		await listen(server, socketPath);

		const { code, output } = await runCli(env, temp);

		assert.strictEqual(requests.length, 1, output);
		assert.strictEqual(code, 1, output);
		assert.match(output, /refused for the test/);
		assert.doesNotMatch(output, /Restarting|Starting Harper/, output);
	});

	it('says Harper is running, without claiming a restart, when it has no domain socket', async () => {
		markRunning();

		const { code, output } = await runCli(env, temp);

		assert.strictEqual(code, 1, output);
		assert.match(output, new RegExp(`running \\(pid ${process.pid}\\) but has no Operations API domain socket`));
		assert.doesNotMatch(output, /not running|Restarting|Starting Harper|already running/, output);
	});

	it('exits non-zero, without claiming a restart, when nothing listens on the domain socket', async () => {
		markRunning();
		fs.writeFileSync(socketPath, '');

		const { code, output } = await runCli(env, temp);

		assert.strictEqual(code, 1, output);
		assert.doesNotMatch(output, /Restarting|Starting Harper|already running/, output);
	});

	it('exits non-zero, without claiming a restart, when the running Harper never answers', async () => {
		markRunning();
		const { server, requests } = operationsServer(null);
		servers.push(server);
		await listen(server, socketPath);
		env.HARPER_CLI_TIMEOUT_MS = '1000';

		const { code, signal, output } = await runCli(env, temp);

		assert.strictEqual(requests.length, 1, output);
		assert.strictEqual(signal, null, 'the CLI timed out by itself rather than being killed');
		assert.strictEqual(code, 1, output);
		assert.doesNotMatch(output, /Restarting|Starting Harper|already running/, output);
	});

	it('does not read the saved login credentials to restart the local instance', async () => {
		markRunning();
		const { server, requests } = operationsServer({ statusCode: 200, body: RESTART_REPLY });
		servers.push(server);
		await listen(server, socketPath);
		const credentialsDir = path.join(env.HOME, '.harperdb');
		fs.mkdirSync(credentialsDir);
		fs.writeFileSync(path.join(credentialsDir, 'credentials.json'), '{ truncated');

		const { code, output } = await runCli(env, temp);

		assert.strictEqual(code, 0, output);
		assert.deepStrictEqual(requests, [{ operation: 'restart' }], output);
	});

	it('refuses a blank target= instead of restarting the local instance', async () => {
		markRunning();
		const { server, requests } = operationsServer({ statusCode: 200, body: RESTART_REPLY });
		servers.push(server);
		await listen(server, socketPath);

		const { code, output } = await runCli(env, temp, 'target=');

		assert.strictEqual(code, 1, output);
		assert.deepStrictEqual(requests, [], output);
		assert.match(output, /target=/);
	});

	it('refuses replicated=true, which the restart operation cannot honor', async () => {
		markRunning();
		const { server, requests } = operationsServer({ statusCode: 200, body: RESTART_REPLY });
		servers.push(server);
		await listen(server, socketPath);

		const { code, output } = await runCli(env, temp, 'replicated=true');

		assert.strictEqual(code, 1, output);
		assert.deepStrictEqual(requests, [], output);
		assert.match(output, /restart_service service=http_workers replicated=true/);
	});

	it('restarts the instance named by target= rather than the local one', async () => {
		const { server, requests } = operationsServer({ statusCode: 200, body: RESTART_REPLY });
		servers.push(server);
		await listen(server, 0, '127.0.0.1');

		const { code, output } = await runCli(env, temp, `target=http://127.0.0.1:${server.address().port}`);

		assert.strictEqual(code, 0, output);
		assert.deepStrictEqual(requests, [{ operation: 'restart' }], output);
		assert.doesNotMatch(output, /Starting Harper/, output);
	});
});
