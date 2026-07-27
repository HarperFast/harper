'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { SERVERS } = require('#src/server/serverRegistry');
const { listenOnPorts } = require('#src/server/threads/threadServer');

/**
 * A domain socket bind can fail at listen() time with an async 'error' event (e.g. EINVAL from an
 * overlong path under a deeply nested rootPath, such as a `.claude/worktrees/<name>` checkout,
 * or ENOENT/EACCES from a missing parent directory), not a synchronous throw. Before this fix,
 * that rejected the Promise.all() covering every listener started in the same batch — TCP ports
 * included — which aborted the whole startup sequence (see bin/run.ts's main(), which
 * process.exit(1)s on any rejection from startHTTPThreads()).
 *
 * This uses a socket path under a non-existent parent directory (not an overlong path) to trigger
 * the failure: an overlong `sun_path` isn't a portable trigger across our supported Node versions
 * — on Node 22.x, libuv silently truncates the path and *succeeds* (the socket file lands at the
 * truncated path, not the requested one) instead of raising EINVAL like Node 24+ does. A missing
 * parent directory reliably produces an async bind error on every supported Node version.
 *
 * Uses real net.Server instances — rather than rewire and a stubbed logger — so the fail-soft
 * behavior is exercised through listenOnPorts()'s real, exported implementation. listenOnPorts()
 * caches its result on a module-level variable after the first call, so both assertions read from
 * one shared real invocation instead of each resetting that private state.
 */
describe('threadServer listenOnPorts — domain socket fail-soft', () => {
	const failingSocketPath = path.join(
		os.tmpdir(),
		`harper-1907-unit-test-${process.pid}`,
		'nonexistent-dir',
		'op.sock'
	);
	let failingServer;
	let tcpServer;
	let results;

	before(async () => {
		failingServer = net.createServer();
		tcpServer = net.createServer();
		SERVERS[failingSocketPath] = failingServer;
		SERVERS['0'] = tcpServer;

		results = await listenOnPorts();
	});

	after(() => {
		failingServer.close();
		tcpServer.close();
		delete SERVERS[failingSocketPath];
		delete SERVERS['0'];
	});

	it('resolves (does not reject) when a domain socket listener fails', () => {
		const failing = results.find((result) => result.port === failingSocketPath);
		assert.ok(failing, 'expected a result for the failing domain socket');
		assert.equal(failing.failed, true);
	});

	it('still resolves a working TCP listener in the same batch', () => {
		const tcp = results.find((result) => result.port === '0');
		assert.ok(tcp, 'expected a result for the sibling TCP listener');
		assert.equal(tcp.failed, undefined);
	});
});
