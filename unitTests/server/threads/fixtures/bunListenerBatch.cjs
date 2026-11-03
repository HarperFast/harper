'use strict';
const assert = require('node:assert');
const net = require('node:net');
require('../../../mocha.init.js');
assert.ok(globalThis.Bun, 'This probe must run inside Bun');
const { SERVERS } = require('#src/server/serverRegistry');
const http = require('#src/server/http');
const { listenOnPorts } = require('#src/server/threads/threadServer');
for (const key of Object.keys(SERVERS)) delete SERVERS[key];
for (const key of Object.keys(http.bunServeConfigs)) delete http.bunServeConfigs[key];

(async () => {
	if (process.argv[2] === 'failure') {
		const socket = '127.0.0.1:-1';
		SERVERS[socket] = net.createServer();
		let original;
		await assert.rejects(listenOnPorts(), (error) => {
			original = error;
			return error.code !== 'EADDRINUSE' && /port|path/.test(error.message);
		});
		await assert.rejects(listenOnPorts(), (error) => error === original);
	} else {
		const bunKey = '127.0.0.1:0';
		const raw = net.createServer((socket) => socket.end());
		SERVERS['127.0.0.1:000'] = raw;
		http.bunServeConfigs[bunKey] = { fetch: () => new Response('ready') };
		const first = listenOnPorts();
		const bunServer = SERVERS[bunKey];
		try {
			const repeated = listenOnPorts();
			assert.strictEqual(typeof first.then, 'function');
			assert.strictEqual(typeof repeated.then, 'function');
			await Promise.all([first, repeated, listenOnPorts()]);
			assert.strictEqual(SERVERS[bunKey], bunServer, 'A repeated call replaced a live Bun server');
			assert.ok(raw.listening);
			const rawPort = raw.address().port;
			const bunPort = bunServer.port;
			bunServer.stop(true);
			await new Promise((resolve) => raw.close(resolve));
			for (const port of [rawPort, bunPort]) {
				const probe = net.createServer();
				await new Promise((resolve, reject) => probe.once('error', reject).listen(port, '127.0.0.1', resolve));
				await new Promise((resolve) => probe.close(resolve));
			}
		} finally {
			bunServer?.stop(true);
			if (raw.listening) await new Promise((resolve) => raw.close(resolve));
		}
	}
	console.log(`Bun ${Bun.version}: ${process.argv[2]} listener batch passed`);
	process.exit(0);
})().catch((error) => {
	console.error(error);
	process.exit(1);
});
