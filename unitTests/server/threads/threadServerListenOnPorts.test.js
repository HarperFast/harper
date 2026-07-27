'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { SERVERS } = require('#src/server/serverRegistry');
const { listenOnPorts } = require('#src/server/threads/threadServer');

/**
 * A too-long Unix domain socket path (e.g. the operations API's domain socket under a deeply
 * nested rootPath, such as a `.claude/worktrees/<name>` checkout) fails at listen() time with an
 * async 'error' event (EINVAL/ENAMETOOLONG), not a synchronous throw. Before this fix, that
 * rejected the Promise.all() covering every listener started in the same batch — TCP ports
 * included — which aborted the whole startup sequence (see bin/run.ts's main(), which
 * process.exit(1)s on any rejection from startHTTPThreads()).
 *
 * Uses real net.Server instances and a real overlong socket path — rather than rewire and a
 * stubbed logger — so the fail-soft behavior is exercised through listenOnPorts()'s real,
 * exported implementation. listenOnPorts() caches its result on a module-level variable after the
 * first call, so both assertions read from one shared real invocation instead of each resetting
 * that private state.
 */
describe('threadServer listenOnPorts — domain socket fail-soft', () => {
	const longSocketPath = path.join(os.tmpdir(), `harper-1907-unit-test-${'a'.repeat(200)}.sock`);
	let failingServer;
	let tcpServer;
	let results;

	before(async () => {
		failingServer = net.createServer();
		tcpServer = net.createServer();
		SERVERS[longSocketPath] = failingServer;
		SERVERS['0'] = tcpServer;

		results = await listenOnPorts();
	});

	after(() => {
		failingServer.close();
		tcpServer.close();
		delete SERVERS[longSocketPath];
		delete SERVERS['0'];
	});

	it('resolves (does not reject) when a domain socket listener fails', () => {
		const failing = results.find((result) => result.port === longSocketPath);
		assert.ok(failing, 'expected a result for the failing domain socket');
		assert.equal(failing.failed, true);
	});

	it('still resolves a working TCP listener in the same batch', () => {
		const tcp = results.find((result) => result.port === '0');
		assert.ok(tcp, 'expected a result for the sibling TCP listener');
		assert.equal(tcp.failed, undefined);
	});
});
