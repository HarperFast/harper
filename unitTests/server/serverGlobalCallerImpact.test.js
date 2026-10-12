'use strict';

// What application code using the `server` global observes from two listener changes:
//  - v5.1.26 (#2019, backport of #2015): a secure port's per-worker Node UDS mirror gets the port's 'upgrade'
//    dispatch, and the port's server carries `udsMirror`. v5.1.x has no uWS backend.
//  - v5.2.0 (#1841, #1858, #2010): TLS listeners carry `appliedCiphers`, `verifiesClientCerts`, `mtlsRequired`.
//    v5.2.0 also first ships the opt-in uWS mirror (HARPER_UWS_UDS, `udsMirrorUwsConfig`).

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const net = require('node:net');
const EventEmitter = require('node:events');
const WebSocket = require('ws');

const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { server } = require('#src/server/Server');
require('#src/server/threads/threadServer'); // side effect: server.socket
const { uwsServeConfigs } = require('#src/server/http'); // loading it installs server.http / ws / upgrade
const { SERVERS, portServer } = require('#src/server/serverRegistry');

// threadServer never binds these; the tests listen the registered objects on loopback themselves, and teardown
// restores the registries so a later listenOnPorts() test does not start them.
let nextPort = 19470;
const STAMPS = ['udsMirror', 'udsMirrorUwsConfig', 'appliedCiphers', 'verifiesClientCerts', 'mtlsRequired'];
const UPGRADE_REQUEST =
	'GET /impact HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
	'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';

function withUnixDomainSockets(enabled, register) {
	const before = env.get(CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS);
	env.setProperty(CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS, enabled);
	try {
		return register();
	} finally {
		env.setProperty(CONFIG_PARAMS.TLS_UNIXDOMAINSOCKETS, before);
	}
}

function mirrorKeyOf(securePort) {
	return Object.keys(SERVERS).find((key) => key.endsWith(`-${securePort}.sock`));
}

const listening = [];
function listenOnLoopback(httpServer) {
	return new Promise((resolve, reject) => {
		httpServer.once('error', reject);
		httpServer.listen(0, '127.0.0.1', () => {
			listening.push(httpServer);
			resolve(httpServer.address().port);
		});
	});
}

function withDeadline(promise, what, ms = 5000) {
	let timer;
	return Promise.race([
		promise,
		new Promise((resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

function withUwsUnixDomainSockets(register) {
	const before = process.env.HARPER_UWS_UDS;
	process.env.HARPER_UWS_UDS = '1';
	try {
		return withUnixDomainSockets(true, register);
	} finally {
		if (before === undefined) delete process.env.HARPER_UWS_UDS;
		else process.env.HARPER_UWS_UDS = before;
	}
}

// Raw socket: reports the bytes the server sent before it closed, sent a complete response head, or `ms` elapsed.
function sendUpgradeAndCollect(port, ms = 2000) {
	return new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1', () => socket.write(UPGRADE_REQUEST));
		let received = '';
		let closed = false;
		socket.on('data', (chunk) => {
			received += chunk;
			if (received.includes('\r\n\r\n')) socket.destroy();
		});
		socket.on('error', () => {});
		socket.on('close', () => {
			closed = true;
			clearTimeout(timer);
			resolve({ received, closed });
		});
		const timer = setTimeout(() => {
			socket.destroy();
			resolve({ received, closed });
		}, ms);
	});
}

describe('server global caller impact: UDS mirror upgrade dispatch (v5.1.26) and TLS listener stamps (v5.2.0)', () => {
	let savedServers, savedUwsConfigs, savedPortServer;
	before(() => {
		savedServers = { ...SERVERS };
		savedUwsConfigs = { ...uwsServeConfigs };
		savedPortServer = new Map(portServer);
	});
	after(() => {
		for (const httpServer of listening) httpServer.close();
		for (const key of Object.keys(SERVERS)) delete SERVERS[key];
		Object.assign(SERVERS, savedServers);
		for (const key of Object.keys(uwsServeConfigs)) delete uwsServeConfigs[key];
		Object.assign(uwsServeConfigs, savedUwsConfigs);
		portServer.clear();
		for (const [key, value] of savedPortServer) portServer.set(key, value);
	});

	describe('server.ws / server.upgrade registration (behavior change only, deployment-dependent)', () => {
		it('server.ws(listener, { securePort }) receives WebSocket connections that arrive on the UDS mirror', async () => {
			// v5.1.25: the mirror had no 'upgrade' listener, so this handshake got a zero-byte close.
			const securePort = nextPort++;
			const connected = new Promise((resolve) => {
				withUnixDomainSockets(true, () =>
					server.ws(
						(ws, request) => {
							ws.send('from-listener');
							resolve(request.pathname);
						},
						{ securePort }
					)
				);
			});
			const mirror = SERVERS[mirrorKeyOf(securePort)];
			assert.ok(mirror, 'the secure port got a UDS mirror');
			assert.strictEqual(SERVERS[securePort].listenerCount('upgrade'), 1);
			assert.strictEqual(mirror.listenerCount('upgrade'), 1);
			const port = await listenOnLoopback(mirror);
			const client = new WebSocket(`ws://127.0.0.1:${port}/impact`);
			try {
				const message = await withDeadline(
					new Promise((resolve, reject) => {
						client.once('message', (data) => resolve(data.toString()));
						client.once('error', reject);
					}),
					'a message from the server.ws listener'
				);
				assert.strictEqual(message, 'from-listener');
				assert.strictEqual(await withDeadline(connected, 'the server.ws listener'), '/impact');
			} finally {
				client.terminate();
			}
		});

		it('server.upgrade(middleware, { securePort }) runs for UDS-mirror handshakes when server.ws is registered on the same port', async () => {
			// v5.1.25: upgrade middleware saw only handshakes on the TLS port.
			const securePort = nextPort++;
			const seen = [];
			withUnixDomainSockets(true, () => {
				server.upgrade(
					(request, socket, head, next) => {
						seen.push(request.url);
						return next(request, socket, head);
					},
					{ securePort, name: 'callerImpactUpgradeMiddleware', runFirst: true }
				);
				server.ws((ws) => ws.close(), { securePort });
			});
			const port = await listenOnLoopback(SERVERS[mirrorKeyOf(securePort)]);
			const { received } = await sendUpgradeAndCollect(port, 1000);
			assert.match(received, /^HTTP\/1\.1 101 /);
			assert.deepStrictEqual(seen, ['/impact']);
		});

		it('server.upgrade(middleware) alone creates no listener at all (unchanged)', () => {
			const securePort = nextPort++;
			withUnixDomainSockets(true, () =>
				server.upgrade((request, socket, head, next) => next(request, socket, head), { securePort })
			);
			assert.strictEqual(SERVERS[securePort], undefined);
			assert.strictEqual(mirrorKeyOf(securePort), undefined);
		});

		it('server.http + server.upgrade with no server.ws on that port: neither the port nor its mirror dispatches upgrades (unchanged)', async () => {
			// Only onWebSocket() attaches the 'upgrade' listener. Plain Node would hand an un-listened upgrade to the
			// request listener; Harper's IncomingMessage.prototype.upgrade override (server/http.ts) prevents that.
			const securePort = nextPort++;
			let middlewareCalls = 0;
			let httpListenerCalls = 0;
			withUnixDomainSockets(true, () => {
				server.http(
					(request, next) => {
						httpListenerCalls++;
						return next(request);
					},
					{ securePort }
				);
				server.upgrade(
					(request, socket, head, next) => {
						middlewareCalls++;
						return next(request, socket, head);
					},
					{ securePort }
				);
			});
			const mirror = SERVERS[mirrorKeyOf(securePort)];
			assert.strictEqual(SERVERS[securePort].listenerCount('upgrade'), 0);
			assert.strictEqual(mirror.listenerCount('upgrade'), 0);
			const { received, closed } = await sendUpgradeAndCollect(await listenOnLoopback(mirror), 1000);
			assert.strictEqual(received, '');
			assert.strictEqual(closed, true);
			assert.strictEqual(middlewareCalls, 0);
			assert.strictEqual(httpListenerCalls, 0);
		});

		it('server.ws(listener, { port }) on a plain port: no mirror exists, so nothing changed', () => {
			const port = nextPort++;
			const [httpServer] = withUnixDomainSockets(true, () => server.ws(() => {}, { port }));
			assert.strictEqual(mirrorKeyOf(port), undefined);
			for (const stamp of STAMPS) assert.ok(!(stamp in httpServer), `${stamp} is not on a plain-port server`);
		});

		it('server.ws(listener, { securePort }) with tls.unixDomainSockets off: no mirror, no udsMirror reference', () => {
			const securePort = nextPort++;
			const [httpServer] = withUnixDomainSockets(false, () => server.ws(() => {}, { securePort }));
			assert.strictEqual(mirrorKeyOf(securePort), undefined);
			assert.strictEqual(httpServer.udsMirror, undefined);
			assert.strictEqual(httpServer.listenerCount('upgrade'), 1);
		});

		it('server.ws(listener, { securePort }) under HARPER_UWS_UDS: the uWS mirror config gets the WebSocket handler', () => {
			// New with v5.2.0's opt-in uWS backend.
			const securePort = nextPort++;
			const [httpServer] = withUwsUnixDomainSockets(() => server.ws(() => {}, { securePort }));
			assert.strictEqual(httpServer.udsMirror, undefined);
			assert.strictEqual(typeof httpServer.udsMirrorUwsConfig?.wsHandler, 'function');
		});

		it('server.upgrade(middleware) under HARPER_UWS_UDS: the uWS mirror runs server.ws listeners but not upgrade middleware', async () => {
			// New with v5.2.0's opt-in uWS backend: uWS accepts the handshake natively, so the upgrade chain is never
			// consulted (warnIfUpgradeMiddlewareUnreachable only logs).
			const securePort = nextPort++;
			let middlewareCalls = 0;
			let reached;
			const listenerReached = new Promise((resolve) => (reached = resolve));
			const [httpServer] = withUwsUnixDomainSockets(() => {
				server.upgrade(
					(request, socket, head, next) => {
						middlewareCalls++;
						return next(request, socket, head);
					},
					{ securePort, name: 'callerImpactUwsUpgradeMiddleware' }
				);
				return server.ws((ws, request) => reached(request.url), { securePort });
			});
			const ws = new EventEmitter();
			ws.close = () => {};
			httpServer.udsMirrorUwsConfig.wsHandler(ws, {
				url: '/impact-uws',
				headers: { host: 'localhost' },
				ip: '127.0.0.1',
			});
			assert.strictEqual(await withDeadline(listenerReached, 'the server.ws listener'), '/impact-uws');
			assert.strictEqual(middlewareCalls, 0);
		});
	});

	describe('server.http(listener) request handling (unaffected)', () => {
		it('server.http(listener, { securePort }) serves plain requests on the UDS mirror, as before both releases', async () => {
			const securePort = nextPort++;
			withUnixDomainSockets(true, () =>
				server.http(
					(request, next) =>
						request.pathname === '/impact-http' ? { status: 200, body: 'from-http-listener' } : next(request),
					{ securePort, name: 'callerImpactHttpListener' }
				)
			);
			const port = await listenOnLoopback(SERVERS[mirrorKeyOf(securePort)]);
			const response = await fetch(`http://127.0.0.1:${port}/impact-http`, { signal: AbortSignal.timeout(5000) });
			assert.strictEqual(response.status, 200);
			assert.strictEqual(await response.text(), 'from-http-listener');
		});
	});

	describe('return values of server.http / server.ws / server.socket (behavior change only for code that reads or enumerates them)', () => {
		it('const [s] = server.http(listener, { securePort }); s.udsMirror is the registered mirror http.Server', () => {
			// v5.1.25: undefined.
			const securePort = nextPort++;
			const [httpServer] = withUnixDomainSockets(true, () => server.http(() => {}, { securePort }));
			assert.strictEqual(httpServer.udsMirror, SERVERS[mirrorKeyOf(securePort)]);
			assert.ok(httpServer.udsMirror instanceof net.Server);
		});

		it('server.ws and server.http return the same server object for the same port', () => {
			const securePort = nextPort++;
			const [fromHttp] = server.http(() => {}, { securePort });
			const [fromWs] = server.ws(() => {}, { securePort });
			assert.strictEqual(fromWs, fromHttp);
		});

		it('reading s.appliedCiphers / s.verifiesClientCerts / s.mtlsRequired on a server.http({ securePort }) result', () => {
			// v5.1.x: all three undefined.
			const securePort = nextPort++;
			const [httpServer] = server.http(() => {}, { securePort });
			assert.ok(httpServer.appliedCiphers === null || typeof httpServer.appliedCiphers === 'string');
			assert.strictEqual(httpServer.verifiesClientCerts, false);
			assert.strictEqual(httpServer.mtlsRequired, false);
		});

		it('Object.keys / for..in / JSON.stringify of a server.http({ securePort }) result now include the new stamps', () => {
			const securePort = nextPort++;
			const [httpServer] = withUnixDomainSockets(true, () => server.http(() => {}, { securePort }));
			const keys = Object.keys(httpServer);
			const iterated = [];
			for (const key in httpServer) iterated.push(key);
			for (const stamp of ['udsMirror', 'appliedCiphers', 'verifiesClientCerts', 'mtlsRequired']) {
				assert.ok(keys.includes(stamp), `${stamp} is an own enumerable key`);
				assert.ok(iterated.includes(stamp), `${stamp} is visited by for..in`);
			}
			const serialized = JSON.parse(JSON.stringify(httpServer));
			assert.strictEqual(typeof serialized.udsMirror, 'object');
			assert.strictEqual(serialized.mtlsRequired, false);
		});

		it('const s = server.socket(listener, { securePort }); s carries the v5.2.0 stamps', () => {
			const securePort = nextPort++;
			const socketServer = withUnixDomainSockets(false, () => server.socket(() => {}, { securePort }));
			assert.ok(socketServer.appliedCiphers === null || typeof socketServer.appliedCiphers === 'string');
			assert.strictEqual(socketServer.verifiesClientCerts, false);
			assert.strictEqual(socketServer.mtlsRequired, false);
		});

		it('const s = server.socket(listener, { port, securePort }); s is the plain TCP server, with no stamps', () => {
			// onSocket returns the last listener it created; the stamped TLS server is only in SERVERS[securePort].
			const port = nextPort++;
			const securePort = nextPort++;
			const socketServer = withUnixDomainSockets(false, () => server.socket(() => {}, { port, securePort }));
			assert.strictEqual(socketServer, SERVERS[port]);
			for (const stamp of STAMPS) assert.ok(!(stamp in socketServer), `${stamp} is not on the plain server`);
			assert.strictEqual(SERVERS[securePort].mtlsRequired, false);
		});
	});

	describe('the server global itself (unaffected)', () => {
		it('Object.keys(server) / reading server.* members: registering listeners adds none of the stamps to the global', () => {
			const securePort = nextPort++;
			const before = Object.keys(server);
			withUnixDomainSockets(true, () => {
				server.http(() => {}, { securePort });
				server.ws(() => {}, { securePort });
				server.upgrade((request, socket, head, next) => next(request, socket, head), { securePort });
			});
			assert.deepStrictEqual(Object.keys(server), before);
			for (const stamp of STAMPS) assert.ok(!(stamp in server), `${stamp} is not on the server global`);
			for (const member of ['http', 'ws', 'upgrade', 'socket']) assert.strictEqual(typeof server[member], 'function');
		});
	});

	describe('fastifyRoutes hand-over (unaffected by v5.2.0)', () => {
		it('a fastifyRoutes app: server.http receives the built fastify http.Server once, never a pending build', async () => {
			// v5.1.26 `server.http((await fastifyServer).server)` and v5.2.0 `server.http(built.server)` after
			// `await fastifyServer` hand over at the same point. A fresh module instance keeps a fastify server another
			// file built from hiding the hand-over; the real server.http is replaced so only the argument is observed.
			const modulePath = require.resolve('#src/server/fastifyRoutes');
			const originalModule = require.cache[modulePath];
			delete require.cache[modulePath];
			const fastifyRoutes = require('#src/server/fastifyRoutes');
			const originalHttp = server.http;
			const handedOver = [];
			server.http = (listener) => handedOver.push(listener);
			// No configured http ports, so the hand-over registers no fastify fallback instance that outlives the test.
			const savedPorts = [CONFIG_PARAMS.HTTP_PORT, CONFIG_PARAMS.HTTP_SECUREPORT].map((key) => [key, env.get(key)]);
			for (const [key] of savedPorts) env.setProperty(key, null);
			try {
				let onEntry;
				const scope = {
					options: { getAll: () => ({}) },
					appName: 'caller-impact-app',
					mount: undefined,
					handleEntry: (handler) => (onEntry = handler),
					requestRestart: () => {},
					externalBasePath: (path) => path,
				};
				fastifyRoutes.handleApplication(scope);
				await onEntry({ eventType: 'add', absolutePath: '/nonexistent/caller-impact-a/routes/a.js' });
				await onEntry({ eventType: 'add', absolutePath: '/nonexistent/caller-impact-b/routes/b.js' });
				assert.strictEqual(handedOver.length, 1);
				assert.ok(handedOver[0] instanceof net.Server, 'a Node http.Server, not a promise');
				assert.strictEqual(typeof handedOver[0].then, 'undefined');
			} finally {
				server.http = originalHttp;
				for (const [key, value] of savedPorts) env.setProperty(key, value);
				if (originalModule) require.cache[modulePath] = originalModule;
				else delete require.cache[modulePath];
			}
		});
	});
});
