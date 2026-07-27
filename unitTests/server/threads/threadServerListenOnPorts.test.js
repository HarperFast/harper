'use strict';

const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { SERVERS } = require('#src/server/serverRegistry');
const { listenOnDomainSocket, listenOnPorts } = require('#src/server/threads/threadServer');
const { getDomainSocketPathMaxBytes } = require('#src/utility/domainSocket');

/**
 * An overlong path is the only domain-socket bind failure that startup may tolerate. Node versions
 * differ on whether they reject or truncate such a path, so the classification itself is tested
 * directly. A missing parent reliably produces a filesystem error and verifies the real
 * listenOnPorts() batch rejects, preserving bin/run.ts's process.exit(1) startup path.
 */
describe('threadServer listenOnPorts — domain socket fail-soft', () => {
	const failingSocketPath = path.join(
		os.tmpdir(),
		`harper-1907-unit-test-${process.pid}`,
		'nonexistent-dir',
		'op.sock'
	);
	let failingServer;
	let listeningServer;
	const listeningSocketPath = path.join(os.tmpdir(), `harper-1907-listening-${process.pid}.sock`);

	after(() => {
		if (failingServer?.listening) failingServer.close();
		if (listeningServer?.listening) listeningServer.close();
		delete SERVERS[failingSocketPath];
	});

	it('skips only an overlong domain socket path', async () => {
		const overlongPath = '/' + 'a'.repeat(getDomainSocketPathMaxBytes());
		const overlongServer = net.createServer();
		const result = await listenOnDomainSocket(overlongPath, overlongServer);
		assert.strictEqual(result.failed, true);
		assert.strictEqual(overlongServer.listening, false);
	});

	it('removes its bind-error listener after a successful listen', async () => {
		listeningServer = net.createServer();
		await listenOnDomainSocket(listeningSocketPath, listeningServer);
		assert.strictEqual(listeningServer.listenerCount('error'), 0);
		await new Promise((resolve) => listeningServer.close(resolve));
	});

	it('rejects startup for a non-path-length domain socket failure', async () => {
		failingServer = net.createServer();
		SERVERS[failingSocketPath] = failingServer;
		await assert.rejects(listenOnPorts());
	});
});
