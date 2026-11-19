/**
 * How the MQTT TCP and WebSocket listeners write to their sockets: a burst to one client goes out in a few writes
 * rather than one per packet, in order, while a lone packet is written at once; socket back-pressure still holds
 * the session; and QoS 1 packet identifiers and acknowledgements are unchanged by the batching.
 * Driven through the real listeners in server/mqtt.ts over loopback (the WebSocket one behind a `ws` server), with
 * the client in this process.
 */
const assert = require('node:assert');
const net = require('node:net');
const { WebSocket, WebSocketServer } = require('ws');
const { EventEmitter } = require('node:events');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { transaction } = require('#src/resources/transaction');
const { handleApplication, bypassAuth } = require('#src/server/mqtt');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const mqttPacket = require('mqtt-packet');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

let sequence = 0;
function topicTable() {
	const name = `SocketWrites${++sequence}`;
	const T = table({
		table: name,
		database: 'mqtt_socket_writes',
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
	Resources.resources.set(name, T, { mqtt: true });
	return { T, name };
}

describe('MQTT TCP socket writes', function () {
	let port;
	let socketServer;
	let restoreAuth;
	let mqttSettings;
	/** The server side of each connection, in the order they were accepted, with its write calls counted. */
	const accepted = [];
	const clients = [];

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		restoreAuth = bypassAuth();
		let listener;
		mqttSettings = { sessions: new Set(), events: new EventEmitter() };
		handleApplication({
			options: { getAll: () => ({ network: { port: 1 } }) },
			server: { ws: () => [], socket: (fn) => ((listener = fn), {}), mqtt: mqttSettings },
		});
		socketServer = net.createServer({ noDelay: true }, (socket) => {
			const { _write, _writev } = net.Socket.prototype;
			const { write } = socket;
			// failAfter: how many more packets the server writes before its next socket.write throws
			const counts = { write: 0, writev: 0, writtenAtOnce: 0, inWrite: false, failAfter: undefined };
			socket._write = function (chunk, encoding, callback) {
				counts.write++;
				// reached from inside the packet's own socket.write: nothing held it back
				if (counts.inWrite) counts.writtenAtOnce++;
				return _write.call(this, chunk, encoding, callback);
			};
			socket._writev = function (chunks, callback) {
				counts.writev++;
				return _writev.call(this, chunks, callback);
			};
			socket.write = function (...args) {
				if (counts.failAfter !== undefined && counts.failAfter-- === 0) throw new Error('injected write failure');
				counts.inWrite = true;
				try {
					return write.apply(this, args);
				} finally {
					counts.inWrite = false;
				}
			};
			accepted.push({ socket, counts });
			listener(socket);
		});
		await new Promise((resolve) => socketServer.listen(0, '127.0.0.1', resolve));
		port = socketServer.address().port;
	});
	after(async () => {
		restoreAuth?.();
		for (const client of clients) client.socket.destroy();
		await waitFor(() => accepted.every(({ socket }) => socket.closed));
		socketServer?.close();
		// nothing of these connections, their mqtt-packet parsers included, outlives the suite
		clients.length = 0;
		accepted.length = 0;
	});

	/** Connects a client and subscribes it to `topic`; its PUBLISHes collect in `publishes`, QoS 1 ones acknowledged. */
	async function connect(clientId, topic, qos = 0) {
		const socket = net.connect({ port, host: '127.0.0.1', noDelay: true });
		const parser = mqttPacket.parser({ protocolVersion: 4 });
		const client = { socket, publishes: [], subacked: false };
		parser.on('packet', (packet) => {
			if (packet.cmd === 'publish') {
				client.publishes.push(packet);
				if (packet.qos === 1) socket.write(mqttPacket.generate({ cmd: 'puback', messageId: packet.messageId }));
			} else if (packet.cmd === 'connack') {
				socket.write(mqttPacket.generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos, rh: 2 }] }));
			} else if (packet.cmd === 'suback') client.subacked = true;
		});
		socket.on('data', (data) => parser.parse(data));
		const acceptedBefore = accepted.length;
		socket.write(
			mqttPacket.generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId, clean: true })
		);
		await waitFor(() => client.subacked);
		client.server = accepted[acceptedBefore];
		clients.push(client);
		return client;
	}
	const values = (client) => client.publishes.map((packet) => JSON.parse(packet.payload).value);
	const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

	it('writes a burst to one client in a few writes, in order', async () => {
		const { T, name } = topicTable();
		const client = await connect('burst', `${name}/r0`);
		const before = { ...client.server.counts };
		await transaction({}, async (context) => {
			for (let i = 0; i < 200; i++) await T.publish('r0', { value: i }, context);
		});
		await waitFor(() => client.publishes.length >= 200);
		assert.deepStrictEqual(values(client), range(0, 200));
		const calls = client.server.counts.write + client.server.counts.writev - before.write - before.writev;
		// one write per packet without batching; with it, one per delivery turn (16 sends)
		assert.ok(calls <= 40, `${calls} socket writes for a burst of 200 packets`);
	});

	it('writes a lone packet at once', async () => {
		const { T, name } = topicTable();
		const fanout = [];
		for (let i = 0; i < 5; i++) fanout.push(await connect(`lone-${i}`, `${name}/r0`));
		const before = fanout.map((client) => ({ ...client.server.counts }));
		await T.publish('r0', { value: 1 });
		await waitFor(() => fanout.every((client) => client.publishes.length === 1));
		fanout.forEach((client, i) => {
			const { write, writev, writtenAtOnce } = client.server.counts;
			assert.strictEqual(write - before[i].write, 1, 'one write for its one packet');
			assert.strictEqual(writev - before[i].writev, 0);
			assert.strictEqual(writtenAtOnce - before[i].writtenAtOnce, 1, 'written inside its own socket.write');
		});
	});

	it('holds the session on socket back-pressure and delivers everything once the client reads', async () => {
		const { T, name } = topicTable();
		const client = await connect('backpressure', `${name}/r0`);
		const server = client.server.socket;
		client.socket.pause();
		const filler = 'x'.repeat(8192);
		const count = 500; // 4 MB, past what the kernel buffers for a client that does not read
		await transaction({}, async (context) => {
			for (let i = 0; i < count; i++) await T.publish('r0', { value: i, filler }, context);
		});
		await waitFor(() => server.writableNeedDrain);
		// the session stopped at the high-water mark rather than queueing the rest in the socket
		const held = server.writableLength;
		await new Promise((resolve) => setTimeout(resolve, 50));
		// the kernel can still take a little from a client that does not read, and the session then sends again
		const limit = server.writableHighWaterMark + 3 * 8300;
		assert.ok(
			held < limit && server.writableLength < limit,
			`${held} bytes held in the socket, then ${server.writableLength}`
		);
		assert.ok(client.publishes.length < count, 'the client has not read everything yet');
		client.socket.resume();
		await waitFor(() => client.publishes.length >= count, 10_000);
		assert.deepStrictEqual(values(client), range(0, count));
	});

	it('writes out what a turn held before a failed delivery aborts the connection', async () => {
		const { T, name } = topicTable();
		const client = await connect('failed', `${name}/r0`);
		let closed = false;
		client.socket.on('close', () => (closed = true));
		// the fifth packet's write throws, failing the delivery partway through a held turn
		client.server.counts.failAfter = 4;
		await transaction({}, async (context) => {
			for (let i = 0; i < 10; i++) await T.publish('r0', { value: i }, context);
		});
		await waitFor(() => closed);
		// the abort discards whatever a corked socket still holds, so the four sent before it are flushed first (LMDB can
		// deliver one record's publishes of a transaction out of order, on main too, so only which ones is checked)
		const received = values(client);
		assert.strictEqual(received.length, 4, `received ${received}`);
		assert.strictEqual(new Set(received).size, 4, `received ${received}`);
		for (const value of received) assert.ok(value >= 0 && value < 10, `received ${received}`);
	});

	it('keeps QoS 1 packet identifiers and acknowledgements in step with a batched burst', async () => {
		const { T, name } = topicTable();
		const client = await connect('qos1', `${name}/r0`, 1);
		const session = [...mqttSettings.sessions].find((candidate) => candidate.sessionId === 'qos1');
		assert.ok(session, 'the session is registered');
		const before = { ...client.server.counts };
		// past the acknowledgement backlog's high-water mark (100), so later sends wait for the client's PUBACKs
		await transaction({}, async (context) => {
			for (let i = 0; i < 250; i++) await T.publish('r0', { value: i }, context);
		});
		await waitFor(() => client.publishes.length >= 250);
		assert.deepStrictEqual(values(client), range(0, 250));
		assert.ok(client.publishes.every((packet) => packet.qos === 1 && !packet.dup));
		// identifiers in flight at once are distinct
		const ids = client.publishes.map((packet) => packet.messageId);
		for (let i = 0; i + 100 <= ids.length; i++) assert.strictEqual(new Set(ids.slice(i, i + 100)).size, 100);
		await waitFor(() => (session.awaitingAcks?.size ?? 0) === 0);
		const calls = client.server.counts.write + client.server.counts.writev - before.write - before.writev;
		assert.ok(calls < 250, `${calls} socket writes for 250 QoS 1 packets`);
	});
});

describe('MQTT WebSocket socket writes', function () {
	let port;
	let wsServer;
	/** The server side of each connection, in the order they were accepted, with its socket's write calls counted. */
	const accepted = [];
	const clients = [];

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		let listener;
		handleApplication({
			options: { getAll: () => ({ webSocket: {} }) },
			server: {
				ws: (fn) => ((listener = fn), []),
				socket: () => ({}),
				mqtt: { sessions: new Set(), events: new EventEmitter() },
			},
		});
		const user = { username: 'mqtt-socket-writes', role: { permission: { super_user: true } } };
		const headers = { 'sec-websocket-protocol': 'mqtt' };
		const request = { headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] }, user };
		wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		wsServer.on('connection', (ws) => {
			const socket = ws._socket;
			const { _write, _writev } = net.Socket.prototype;
			const counts = { write: 0, writev: 0 };
			socket._write = function (chunk, encoding, callback) {
				counts.write++;
				return _write.call(this, chunk, encoding, callback);
			};
			socket._writev = function (chunks, callback) {
				counts.writev++;
				return _writev.call(this, chunks, callback);
			};
			accepted.push({ socket, counts });
			listener(ws, request, Promise.resolve({ status: 200 }), () => {});
		});
		await new Promise((resolve) => wsServer.on('listening', resolve));
		port = wsServer.address().port;
	});
	after(async () => {
		for (const client of clients) client.ws.terminate();
		await waitFor(() => accepted.every(({ socket }) => socket.closed));
		await new Promise((resolve) => wsServer?.close(resolve));
		// nothing of these connections, their mqtt-packet parsers included, outlives the suite
		clients.length = 0;
		accepted.length = 0;
	});

	/** Connects a client over a WebSocket and subscribes it to `topic`; its PUBLISHes collect in `publishes`. */
	async function connect(clientId, topic) {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`, 'mqtt');
		const parser = mqttPacket.parser({ protocolVersion: 4 });
		const client = { ws, publishes: [], subacked: false };
		parser.on('packet', (packet) => {
			if (packet.cmd === 'publish') client.publishes.push(packet);
			else if (packet.cmd === 'connack') {
				ws.send(mqttPacket.generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos: 0, rh: 2 }] }));
			} else if (packet.cmd === 'suback') client.subacked = true;
		});
		ws.on('message', (data) => parser.parse(data));
		const acceptedBefore = accepted.length;
		await new Promise((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('error', reject);
		});
		ws.send(mqttPacket.generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId, clean: true }));
		await waitFor(() => client.subacked);
		client.server = accepted[acceptedBefore];
		clients.push(client);
		return client;
	}
	const values = (client) => client.publishes.map((packet) => JSON.parse(packet.payload).value);
	const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

	it('writes a burst to one client in a few writes, in order', async () => {
		const { T, name } = topicTable();
		const client = await connect('ws-burst', `${name}/r0`);
		const before = { ...client.server.counts };
		await transaction({}, async (context) => {
			for (let i = 0; i < 200; i++) await T.publish('r0', { value: i }, context);
		});
		await waitFor(() => client.publishes.length >= 200);
		assert.deepStrictEqual(values(client), range(0, 200));
		const calls = client.server.counts.write + client.server.counts.writev - before.write - before.writev;
		// one writev (frame header and payload) per packet without batching; with it, one per delivery turn
		assert.ok(calls <= 40, `${calls} socket writes for a burst of 200 packets`);
	});

	it('holds the session on socket back-pressure and delivers everything once the client reads', async () => {
		const { T, name } = topicTable();
		const client = await connect('ws-backpressure', `${name}/r0`);
		const server = client.server.socket;
		client.ws._socket.pause();
		const filler = 'x'.repeat(8192);
		const count = 500; // 4 MB, past what the kernel buffers for a client that does not read
		await transaction({}, async (context) => {
			for (let i = 0; i < count; i++) await T.publish('r0', { value: i, filler }, context);
		});
		await waitFor(() => server.writableNeedDrain);
		// the session stopped at the high-water mark rather than queueing the rest in the socket
		const held = server.writableLength;
		await new Promise((resolve) => setTimeout(resolve, 50));
		// the kernel can still take a little from a client that does not read, and the session then sends again
		const limit = server.writableHighWaterMark + 3 * 8300;
		assert.ok(
			held < limit && server.writableLength < limit,
			`${held} bytes held in the socket, then ${server.writableLength}`
		);
		assert.ok(client.publishes.length < count, 'the client has not read everything yet');
		client.ws._socket.resume();
		await waitFor(() => client.publishes.length >= count, 10_000);
		assert.deepStrictEqual(values(client), range(0, count));
	});
});
