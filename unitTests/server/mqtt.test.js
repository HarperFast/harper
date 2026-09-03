'use strict';

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const assert = require('assert');

const { handleApplication } = require('#src/server/mqtt');

// Regression coverage for the split from #1999: MQTT's raw-socket listener must keep
// registering with its own `usageType` so createTLSSelector/getEffectiveTlsCiphers can give
// mqtt-tagged certificates exact-match priority (see unitTests/security/keys.test.js for the
// certificate-selection side of this contract).
describe('mqtt.ts handleApplication raw-socket registration', () => {
	function recordingServer() {
		const calls = [];
		// handleApplication stores server.socket()'s return value (serverInstances.push(...)), so
		// the recorder returns an object rather than calls.push()'s length to match that shape.
		return { socket: (...args) => (calls.push(args), {}), calls };
	}

	it('registers no listener when neither port nor securePort is configured', () => {
		const server = recordingServer();
		const scope = {
			options: { getAll: () => ({ network: {} }) },
			server,
		};

		handleApplication(scope);

		assert.strictEqual(server.calls.length, 0);
	});

	it("registers the raw TCP/TLS listener with securePort, mtls, and usageType 'mqtt' forwarded", () => {
		const server = recordingServer();
		const mtls = { required: true };
		const scope = {
			options: { getAll: () => ({ network: { securePort: 8883, mtls } }) },
			server,
		};

		handleApplication(scope);

		assert.strictEqual(server.calls.length, 1);
		assert.deepStrictEqual(server.calls[0][1], { port: undefined, securePort: 8883, mtls, usageType: 'mqtt' });
	});

	it('registers the listener from a plain (non-TLS) port alone, without requiring securePort', () => {
		// server/mqtt.ts sets `usageType: 'mqtt'` unconditionally in one options literal, so this
		// doesn't add distinct usageType coverage over the test above — what it actually pins is
		// the `if (port || securePort)` guard at server/mqtt.ts:88 firing for a port-only config.
		const server = recordingServer();
		const scope = {
			options: { getAll: () => ({ network: { port: 1883 } }) },
			server,
		};

		handleApplication(scope);

		assert.strictEqual(server.calls.length, 1);
		assert.deepStrictEqual(server.calls[0][1], {
			port: 1883,
			securePort: undefined,
			mtls: undefined,
			usageType: 'mqtt',
		});
	});
});

// The WebSocket entry points in server/http.ts call `httpChain[port](request)` and hand this
// listener the still-pending completion, so authentication has not resolved the credential yet when
// the listener runs. Reading the deferred-rejection state synchronously therefore always saw
// `undefined`, and an invalid Authorization header connected anonymously wherever MQTT allows
// anonymous connections (#2418).
describe('mqtt.ts WebSocket listener settles authentication before the session starts', () => {
	const { credentialRejectionError, deferCredentialRejection } = require('#src/security/deferredAuthentication');
	const { generate } = require('mqtt-packet');

	/** Captures the listener `handleApplication` registers through `server.ws()`. */
	function webSocketListener() {
		let listener;
		const server = {
			ws: (fn) => ((listener = fn), []),
			socket: () => ({}),
		};
		handleApplication({ options: { getAll: () => ({ webSocket: {} }) }, server });
		return listener;
	}

	function fakeWebSocket() {
		const closes = [];
		const sends = [];
		const handlers = {};
		return {
			closes,
			sends,
			handlers,
			_socket: { remoteAddress: '127.0.0.1' },
			close: (code, reason) => closes.push({ code, reason }),
			send: (message) => sends.push(message),
			on: (event, handler) => {
				handlers[event] = handler;
			},
		};
	}

	function mqttUpgradeRequest(headers = {}) {
		const asObject = { 'sec-websocket-protocol': 'mqtt', ...headers };
		return { headers: { asObject, get: (name) => asObject[name.toLowerCase()] } };
	}

	/** Lets every already-queued microtask and the `.catch` continuation run. */
	const settle = () => new Promise((resolve) => setImmediate(resolve));

	it('closes the socket once an asynchronously-recorded credential rejection settles', async () => {
		const listener = webSocketListener();
		const ws = fakeWebSocket();
		const request = mqttUpgradeRequest({ authorization: 'Basic d29yZHByZXNzOnNlY3JldA==' });
		// The real shape: `authentication` yields on the user lookup before it can classify the
		// credential, so the rejection is recorded a turn after this listener is invoked.
		const chainCompletion = (async () => {
			await Promise.resolve();
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');
			return { status: 200 };
		})();

		listener(ws, request, chainCompletion, () => {
			throw new Error('a mqtt-subprotocol upgrade must not fall through to the next listener');
		});

		// Nothing is knowable yet — that is exactly why a synchronous check could not work.
		assert.deepStrictEqual(ws.closes, []);
		await chainCompletion;
		await settle();

		assert.deepStrictEqual(ws.closes, [{ code: 3000, reason: 'Login failed' }]);
	});

	it('does not accept the subsequent CONNECT anonymously', async () => {
		// The consequence the synchronous check was supposed to prevent: this scope allows anonymous
		// connections, so a CONNECT that follows an invalid Authorization header was answered with a
		// CONNACK and given an anonymous session.
		const listener = webSocketListener();
		const ws = fakeWebSocket();
		const request = mqttUpgradeRequest({ authorization: 'Basic d29yZHByZXNzOnNlY3JldA==' });
		const chainCompletion = (async () => {
			await Promise.resolve();
			deferCredentialRejection(request, credentialRejectionError('Login failed', 401), 'Basic');
			return { status: 200 };
		})();

		listener(ws, request, chainCompletion, () => {});
		await chainCompletion;
		await settle();

		ws.handlers.message(
			generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId: 'woo-client', clean: true })
		);
		await settle();
		await settle();

		assert.deepStrictEqual(ws.sends, [], 'no CONNACK may be sent for a rejected credential');
		assert.ok(ws.closes.length > 0, 'the connection must be closed rather than served anonymously');
	});

	it('leaves an authenticated connection open and attaches its handlers synchronously', async () => {
		const listener = webSocketListener();
		const ws = fakeWebSocket();
		const request = mqttUpgradeRequest({ authorization: 'Basic aGFycGVyOnB3' });
		const chainCompletion = (async () => {
			await Promise.resolve();
			request.user = { username: 'harper_admin' };
			return { status: 200 };
		})();

		listener(ws, request, chainCompletion, () => {});

		// Handlers must be in place before the chain settles, or frames that arrive in that window
		// would be dropped.
		assert.strictEqual(typeof ws.handlers.message, 'function');
		assert.strictEqual(typeof ws.handlers.close, 'function');
		await chainCompletion;
		await settle();

		assert.deepStrictEqual(ws.closes, []);
	});

	it('passes a non-mqtt subprotocol upgrade straight to the next listener', async () => {
		const listener = webSocketListener();
		const ws = fakeWebSocket();
		const request = mqttUpgradeRequest({ 'sec-websocket-protocol': 'graphql-ws' });
		let forwarded = false;

		listener(ws, request, Promise.resolve({ status: 200 }), () => {
			forwarded = true;
		});
		await settle();

		assert.strictEqual(forwarded, true);
		assert.deepStrictEqual(ws.closes, []);
	});
});
