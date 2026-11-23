/**
 * server/mqtt and server/REST each register a connection-count analytics listener from the first connection the
 * module sees, and the thread keeps that listener. A closure made in the connection handler shares the connection's
 * context, so it would keep the first connection for the thread's lifetime.
 */
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');

let freshImports = 0;
/** Another instance of a module, whose module state (what its first connection registers) starts empty. */
async function freshModule(specifier) {
	const path = require.resolve(specifier);
	// source runs load it as an ES module, which a distinct URL instantiates again
	if (path.endsWith('.ts')) return import(`${pathToFileURL(path).href}?fresh=${++freshImports}`);
	const loaded = require.cache[path];
	delete require.cache[path];
	try {
		return require(path);
	} finally {
		require.cache[path] = loaded;
	}
}

function webSocketListener(handleApplication, options) {
	let listener;
	handleApplication({
		...options,
		options: { getAll: () => ({ webSocket: {} }) },
		server: {
			http: () => {},
			ws: (fn) => ((listener = fn), []),
			socket: () => ({}),
			mqtt: { sessions: new Set(), events: new EventEmitter() },
		},
	});
	return listener;
}

function webSocket() {
	const rawSocket = new EventEmitter();
	rawSocket.remoteAddress = '127.0.0.1';
	const ws = { handlers: {}, _socket: rawSocket, close() {}, terminate() {}, destroy() {}, send() {} };
	ws.on = (event, handler) => (ws.handlers[event] = handler);
	return ws;
}

function upgradeRequest(protocol) {
	const headers = { 'sec-websocket-protocol': protocol };
	return {
		method: 'GET',
		url: '/NoSuchResource',
		pathname: '/NoSuchResource',
		isWebSocket: true,
		user: { username: 'connection-metric-test', role: { permission: { super_user: true } } },
		headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] },
	};
}

async function closedConnection(listener, protocol) {
	const ws = webSocket();
	const request = upgradeRequest(protocol);
	const handled = listener(ws, request, Promise.resolve({ status: 200 }), () => {});
	ws.handlers.close();
	await handled;
	return { ws: new WeakRef(ws), request: new WeakRef(request) };
}

// polled: a WeakRef keeps its target to the end of the turn it was made or read in
async function assertCollected({ ws, request }) {
	await waitFor(() => (global.gc(), ws.deref() === undefined && request.deref() === undefined), {
		message: 'the thread still references a closed connection',
	});
}

describe('connection-count analytics listeners', function () {
	before(function () {
		if (typeof global.gc !== 'function') this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it("keep nothing of an MQTT module's first connection once it closes", async () => {
		const { handleApplication } = await freshModule('#src/server/mqtt');
		const connection = await closedConnection(webSocketListener(handleApplication), 'mqtt');
		await assertCollected(connection);
	});

	it("keep nothing of a REST module's first WebSocket connection once it closes", async () => {
		const { handleApplication } = await freshModule('#src/server/REST');
		const listener = webSocketListener(handleApplication, {
			resources: { getMatch: () => undefined },
			routeFor: () => ({ host: undefined, urlPath: '/connection-metric' }),
		});
		assert.strictEqual(typeof listener, 'function');
		await assertCollected(await closedConnection(listener));
	});
});
