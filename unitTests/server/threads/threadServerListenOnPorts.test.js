'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { SERVERS } = require('#src/server/serverRegistry');
const { listenOnDomainSocket, listenOnPorts } = require('#src/server/threads/threadServer');
const { registerUdsCleanupPaths, cleanupUdsFiles } = require('#src/server/http');
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

/**
 * libuv unlinks a pipe server's bound path on close whoever owns it by then, so a per-thread mirror
 * is bound at a temp name and renamed over its published path (#2961).
 */
describe('threadServer listenOnDomainSocket — per-thread mirrors survive the previous owner closing', () => {
	const socketsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harper-2961-'));
	const mirrorPath = path.join(socketsDir, '0-9926.sock');
	const open = [];

	const mirror = () => {
		const server = net.createServer((socket) => socket.end(`served by ${server.tag}`));
		server.isPerThreadSocket = true;
		open.push(server);
		return server;
	};
	const identity = (socketPath) => {
		const stat = fs.statSync(socketPath, { bigint: true });
		return `${stat.dev}:${stat.ino}`;
	};
	const close = (server) => new Promise((resolve) => server.close(resolve));
	const servedBy = (socketPath) =>
		new Promise((resolve, reject) => {
			let data = '';
			net
				.connect(socketPath)
				.on('data', (chunk) => (data += chunk))
				.on('end', () => resolve(data))
				.on('error', reject);
		});

	after(async () => {
		for (const server of open) if (server.listening) await close(server);
		fs.rmSync(socketsDir, { recursive: true, force: true });
	});

	it('publishes only the final name, and the ownership recorded for it is the listening inode', async () => {
		const server = mirror();
		server.tag = 'first';
		registerUdsCleanupPaths(mirrorPath, path.join(socketsDir, '0-9926.yaml'));
		await listenOnDomainSocket(mirrorPath, server);
		assert.deepStrictEqual(fs.readdirSync(socketsDir), ['0-9926.sock']);
		assert.strictEqual(await servedBy(mirrorPath), 'served by first');
		cleanupUdsFiles();
		assert.strictEqual(fs.existsSync(mirrorPath), false, 'cleanupUdsFiles() did not recognize its own socket');
		await close(server);
		assert.deepStrictEqual(fs.readdirSync(socketsDir), [], 'close() left a temp file behind');
	});

	it('THE REGRESSION: the replacement that rebound the path keeps its socket after the outgoing server closes', async () => {
		const outgoing = mirror();
		outgoing.tag = 'outgoing';
		await listenOnDomainSocket(mirrorPath, outgoing);
		const outgoingIdentity = identity(mirrorPath);
		const replacement = mirror();
		replacement.tag = 'replacement';
		await listenOnDomainSocket(mirrorPath, replacement);
		const replacementIdentity = identity(mirrorPath);
		assert.notStrictEqual(replacementIdentity, outgoingIdentity);

		await close(outgoing);

		assert.strictEqual(fs.existsSync(mirrorPath), true, 'the outgoing close removed the replacement socket');
		assert.strictEqual(identity(mirrorPath), replacementIdentity);
		assert.strictEqual(await servedBy(mirrorPath), 'served by replacement');
		assert.deepStrictEqual(fs.readdirSync(socketsDir), ['0-9926.sock']);
		await close(replacement);
		fs.unlinkSync(mirrorPath);
	});

	it('a failed rename leaves no temp file and rejects the bind', async () => {
		const blockedPath = path.join(socketsDir, '1-9926.sock');
		fs.mkdirSync(blockedPath);
		fs.writeFileSync(path.join(blockedPath, 'occupant'), '');
		const server = mirror();
		await assert.rejects(listenOnDomainSocket(blockedPath, server), (error) => error.code !== undefined);
		assert.deepStrictEqual(fs.readdirSync(socketsDir).sort(), ['1-9926.sock']);
		fs.rmSync(blockedPath, { recursive: true });
	});

	it('the uWS mirror keeps its direct bind because uWS close() never unlinks a listen_unix path', async function () {
		let uWS;
		try {
			uWS = require('uWebSockets.js');
		} catch {
			this.skip(); // optional, platform-specific dependency
		}
		const uwsPath = path.join(socketsDir, '2-9926.sock');
		const listenUnix = (app) =>
			new Promise((resolve, reject) =>
				app.listen_unix(
					(token) => (token ? resolve(token) : reject(new Error(`uWS could not bind ${uwsPath}`))),
					uwsPath
				)
			);
		const outgoing = uWS.App();
		await listenUnix(outgoing);
		fs.unlinkSync(uwsPath);
		const replacement = uWS.App();
		await listenUnix(replacement);
		const replacementIdentity = identity(uwsPath);
		outgoing.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.ok(fs.existsSync(uwsPath), 'uWS close() unlinked the path: apply the temp+rename there too');
		assert.strictEqual(identity(uwsPath), replacementIdentity);
		replacement.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.strictEqual(
			fs.existsSync(uwsPath),
			true,
			'uWS close() now unlinks its own path: apply the temp+rename there too'
		);
		fs.unlinkSync(uwsPath);
	});

	it('a non-mirror domain socket binds directly, so its file is removed on close', async () => {
		const operationsPath = path.join(socketsDir, 'operations-api.sock');
		const server = net.createServer();
		open.push(server);
		await listenOnDomainSocket(operationsPath, server);
		assert.strictEqual(fs.existsSync(operationsPath), true);
		await close(server);
		assert.strictEqual(fs.existsSync(operationsPath), false);
	});
});
