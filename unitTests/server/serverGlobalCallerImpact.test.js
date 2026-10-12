'use strict';

// Pins what application code using the `server` global observes from two listener changes:
//  - v5.1.26 (e7f6d456e, #2019 / main c28e5f83f, #2015): a secure port's per-worker UDS mirror gets the same
//    'upgrade' dispatch as the port, and the port's server object carries a `udsMirror` reference.
//  - v5.2.0 (56a2bace9 #1841, 0f0771b60 #1858, 1f59addc7 #2010): TLS listeners resolve ciphers per usage type and
//    carry `appliedCiphers`, `verifiesClientCerts`, `mtlsRequired` (and `udsMirrorUwsConfig` under HARPER_UWS_UDS).
// Each `it` is named for the caller code shape it represents.

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('node:assert');
const net = require('node:net');
const sinon = require('sinon');
const WebSocket = require('ws');

const env = require('#src/utility/environment/environmentManager');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
const { server } = require('#src/server/Server');
require('#src/server/http'); // side effect: server.http / server.ws / server.upgrade
require('#src/server/threads/threadServer'); // side effect: server.socket
const { SERVERS } = require('#src/server/serverRegistry');

// Never bound by threadServer here: these tests construct listeners through the server global and listen the
// objects themselves on ephemeral loopback ports.
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
	return new Promise((resolve) => {
		httpServer.listen(0, '127.0.0.1', () => {
			listening.push(httpServer);
			resolve(httpServer.address().port);
		});
	});
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
	after(() => {
		for (const httpServer of listening) httpServer.close();
	});

	describe('server.ws / server.upgrade registration (behavior change only, deployment-dependent)', () => {
		it('server.ws(listener, { securePort }) receives WebSocket connections that arrive on the UDS mirror', async () => {
			// Before v5.1.26 the mirror had no 'upgrade' listener, so this handshake got a zero-byte close and the
			// listener never ran; only clients reaching the TLS port directly were served.
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
			assert.strictEqual(mirror.listenerCount('upgrade'), 1);
			const port = await listenOnLoopback(mirror);
			const client = new WebSocket(`ws://127.0.0.1:${port}/impact`);
			try {
				const message = await new Promise((resolve, reject) => {
					client.once('message', (data) => resolve(data.toString()));
					client.once('error', reject);
				});
				assert.strictEqual(message, 'from-listener');
				assert.strictEqual(await connected, '/impact');
			} finally {
				client.terminate();
			}
		});

		it('server.upgrade(middleware, { securePort }) runs for UDS-mirror handshakes when server.ws is registered on the same port', async () => {
			// Same v5.1.26 change: the mirror now dispatches into the port's upgrade chain, so upgrade middleware that
			// previously only saw TCP-port handshakes also sees mirror handshakes.
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
			// onUpgrade() only registers a chain entry; it never constructs the port's server or its mirror.
			const securePort = nextPort++;
			withUnixDomainSockets(true, () =>
				server.upgrade((request, socket, head, next) => next(request, socket, head), { securePort })
			);
			assert.strictEqual(SERVERS[securePort], undefined);
			assert.strictEqual(mirrorKeyOf(securePort), undefined);
		});

		it('server.http + server.upgrade with no server.ws on that port: neither the port nor its mirror dispatches upgrades (unchanged)', async () => {
			// The 'upgrade' listener is attached only by onWebSocket(). That was true of the TCP port before v5.1.26 and
			// is true of both listeners now. The handshake gets a zero-byte close rather than reaching the server.http
			// listener: Harper's IncomingMessage.prototype.upgrade override (server/http.ts) defeats Node's fallback of
			// handling an un-listened upgrade as a plain request.
			const securePort = nextPort++;
			const middleware = sinon.spy((request, socket, head, next) => next(request, socket, head));
			const httpListener = sinon.spy((request, next) => next(request));
			withUnixDomainSockets(true, () => {
				server.http(httpListener, { securePort });
				server.upgrade(middleware, { securePort });
			});
			const mirror = SERVERS[mirrorKeyOf(securePort)];
			assert.strictEqual(SERVERS[securePort].listenerCount('upgrade'), 0);
			assert.strictEqual(mirror.listenerCount('upgrade'), 0);
			const { received, closed } = await sendUpgradeAndCollect(await listenOnLoopback(mirror), 1000);
			assert.strictEqual(received, '');
			assert.strictEqual(closed, true);
			assert.strictEqual(middleware.callCount, 0);
			assert.strictEqual(httpListener.callCount, 0);
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
			// v5.1.26 also closed this gap for the uWS-served mirror; before it, udsMirrorUwsConfig had no wsHandler.
			const securePort = nextPort++;
			const before = process.env.HARPER_UWS_UDS;
			process.env.HARPER_UWS_UDS = '1';
			let httpServer;
			try {
				[httpServer] = withUnixDomainSockets(true, () => server.ws(() => {}, { securePort }));
			} finally {
				if (before === undefined) delete process.env.HARPER_UWS_UDS;
				else process.env.HARPER_UWS_UDS = before;
			}
			assert.strictEqual(httpServer.udsMirror, undefined);
			assert.strictEqual(typeof httpServer.udsMirrorUwsConfig?.wsHandler, 'function');
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
			const response = await fetch(`http://127.0.0.1:${port}/impact-http`);
			assert.strictEqual(response.status, 200);
			assert.strictEqual(await response.text(), 'from-http-listener');
		});
	});

	describe('return values of server.http / server.ws / server.socket (behavior change only for code that reads or enumerates them)', () => {
		it('const [s] = server.http(listener, { securePort }); s.udsMirror is the registered mirror http.Server', () => {
			// Added in v5.1.26; undefined before.
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
			// Added in v5.2.0; all three were undefined on v5.1.x.
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
			// Serializing still succeeds; it now nests the mirror server.
			const serialized = JSON.parse(JSON.stringify(httpServer));
			assert.strictEqual(typeof serialized.udsMirror, 'object');
			assert.strictEqual(serialized.mtlsRequired, false);
		});

		it('const s = server.socket(listener, { securePort }); s carries the v5.2.0 stamps', () => {
			const securePort = nextPort++;
			const socketServer = withUnixDomainSockets(false, () => server.socket(() => {}, { securePort }));
			try {
				assert.ok(socketServer.appliedCiphers === null || typeof socketServer.appliedCiphers === 'string');
				assert.strictEqual(socketServer.verifiesClientCerts, false);
				assert.strictEqual(socketServer.mtlsRequired, false);
			} finally {
				delete SERVERS[securePort];
			}
		});

		it('const s = server.socket(listener, { port, securePort }); s is the plain TCP server, with no stamps', () => {
			// The return value is the last listener created, which is the plain one when both ports are given; the
			// stamps live on the TLS server registered in SERVERS[securePort], which the caller does not receive.
			const port = nextPort++;
			const securePort = nextPort++;
			const socketServer = withUnixDomainSockets(false, () => server.socket(() => {}, { port, securePort }));
			try {
				assert.strictEqual(socketServer, SERVERS[port]);
				for (const stamp of STAMPS) assert.ok(!(stamp in socketServer), `${stamp} is not on the plain server`);
				assert.strictEqual(SERVERS[securePort].mtlsRequired, false);
			} finally {
				delete SERVERS[port];
				delete SERVERS[securePort];
			}
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
			// v5.1.26: `server.http((await fastifyServer).server)`; v5.2.0+: `const built = await fastifyServer;
			// server.http(built.server)`. Both await the build before the hand-over and both hand over before
			// fastify's ready(); the timing did not change.
			const modulePath = require.resolve('#src/server/fastifyRoutes');
			delete require.cache[modulePath];
			const fastifyRoutes = require('#src/server/fastifyRoutes');
			const handOver = sinon.stub(server, 'http');
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
				assert.strictEqual(handOver.callCount, 1);
				const [handedOver] = handOver.firstCall.args;
				assert.ok(handedOver instanceof net.Server, 'a Node http.Server, not a promise');
				assert.strictEqual(typeof handedOver.then, 'undefined');
			} finally {
				handOver.restore();
				delete require.cache[modulePath];
			}
		});
	});
});
