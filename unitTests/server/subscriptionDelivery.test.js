const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { transaction, contextStorage } = require('#src/resources/transaction');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { handleApplication } = require('#src/server/mqtt');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const mqttPacket = require('mqtt-packet');
const { generate } = mqttPacket;
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const user = { username: 'subscription-delivery-test', role: { permission: { super_user: true } } };

/** The MQTT WebSocket listener, as mqtt.ts registers it with a server. */
function mqttWebSocketListener() {
	let listener;
	const server = {
		ws: (fn) => ((listener = fn), []),
		socket: () => ({}),
		mqtt: { sessions: new Set(), events: new EventEmitter() },
	};
	handleApplication({ options: { getAll: () => ({ webSocket: {} }) }, server });
	return { listener, server };
}

/** A WebSocket that records what is sent, over a raw socket whose back-pressure a test can set. */
function fakeWebSocket() {
	const rawSocket = new EventEmitter();
	rawSocket.remoteAddress = '127.0.0.1';
	const socket = { handlers: {}, sent: [], rawSocket, _socket: rawSocket, close() {}, terminate() {} };
	socket.send = (packet) => socket.sent.push(packet);
	socket.on = (event, handler) => (socket.handlers[event] = handler);
	return socket;
}

function mqttUpgradeRequest() {
	const headers = { 'sec-websocket-protocol': 'mqtt' };
	return { headers: { asObject: headers, get: (header) => headers[header.toLowerCase()] }, user };
}

let sequence = 0;
function topicTable() {
	const name = `DeliveryTopic${++sequence}`;
	const T = table({
		table: name,
		database: `delivery_${name}`,
		audit: true,
		attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
	});
	Resources.resources.set(name, T, { mqtt: true });
	return { T, name };
}

describe('MQTT subscription delivery', function () {
	this.timeout(30_000);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});

	it('yields to the event loop within a bounded number of deliveries, however many subscriptions share a backlog', async () => {
		const { T, name } = topicTable();
		const subscribers = 20;
		const records = 200;
		let delivered = 0;
		let deliveredWhenOtherWorkRan;
		const sessions = [];
		for (let i = 0; i < subscribers; i++) {
			const session = await getSession({ clientId: `pacing-${name}-${i}`, user, clean: true });
			session.setListener(() => {
				// work queued behind the first delivery must get a turn long before the backlog is gone
				if (delivered++ === 0) setImmediate(() => (deliveredWhenOtherWorkRan = delivered));
				return true;
			});
			await session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
			sessions.push(session);
		}
		await transaction({}, async (context) => {
			for (let i = 0; i < records; i++) await T.put(`r${i}`, { value: i }, context);
		});
		await waitFor(() => delivered === subscribers * records, 10_000);
		assert.ok(deliveredWhenOtherWorkRan !== undefined);
		// one turn's budget, plus at most one more delivery from each subscription already resumed
		assert.ok(
			deliveredWhenOtherWorkRan <= 1000 + subscribers,
			`${deliveredWhenOtherWorkRan} of ${subscribers * records} deliveries ran before the event loop turned`
		);
		for (const session of sessions) session.disconnect(true);
	});

	// A computed attribute's resolver can read the async context (getContext()) while a message is
	// serialized, so a message must go out in its subscriber's context, not in the context of whichever
	// request wrote the record and so set off the notification.
	it('sends each message in the async context its subscription was opened in, whatever context wrote it', async () => {
		const { T, name } = topicTable();
		const seen = [];
		const session = await getSession({ clientId: `context-${name}`, user, clean: true });
		session.setListener(() => {
			seen.push(contextStorage.getStore()?.topic);
			return true;
		});
		await session.addSubscription({ topic: `${name}/#`, qos: 0, rh: 2 }, false);
		await contextStorage.run({ topic: 'the writer’s context' }, () => T.put('r1', { value: 1 }));
		await waitFor(() => seen.length === 1);
		assert.deepStrictEqual(seen, [`${name}/#`]);
		session.disconnect(true);
	});

	it('delivers to a mid-level single-level wildcard only the records whose levels match it', async () => {
		const { T, name } = topicTable();
		const delivered = [];
		const session = await getSession({ clientId: `wildcard-${name}`, user, clean: true });
		session.setListener((topic) => {
			delivered.push(topic);
			return true;
		});
		await session.addSubscription({ topic: `${name}/site/+/temp`, qos: 0, rh: 2 }, false);
		await T.put('site/a/temp', { value: 1 });
		await T.put('site/b/humidity', { value: 2 });
		await T.put('site/c/temp/extra', { value: 3 });
		await T.put('site/d/temp', { value: 4 });
		await waitFor(() => delivered.includes(`${name}/site/d/temp`));
		assert.deepStrictEqual(delivered, [`${name}/site/a/temp`, `${name}/site/d/temp`]);
		session.disconnect(true);
	});

	for (const protocolVersion of [4, 5]) {
		it(`sends each QoS 1 subscriber of a message its own packet identifier around the shared payload (MQTT v${protocolVersion})`, async () => {
			const { listener, server } = mqttWebSocketListener();
			const socket = fakeWebSocket();
			listener(socket, mqttUpgradeRequest(), Promise.resolve({ status: 200 }), () => {});
			socket.handlers.message(
				generate({
					cmd: 'connect',
					protocolId: 'MQTT',
					protocolVersion,
					clientId: `qos1-${protocolVersion}`,
					clean: true,
				})
			);
			await waitFor(() => server.mqtt.sessions.size === 1);
			const [session] = server.mqtt.sessions;
			const message = { value: 'shared', reading: [1, 2, 3] };
			// the first send encodes, the second stores the template, the rest copy it
			for (const messageId of [11, 12, 13, 14]) session.listener('Topic/a', message, messageId, { qos: 1 }, 7);
			const parser = mqttPacket.parser({ protocolVersion });
			const publishes = [];
			parser.on('packet', (packet) => packet.cmd === 'publish' && publishes.push(packet));
			for (const sent of socket.sent) parser.parse(sent);
			assert.deepStrictEqual(
				publishes.map(({ messageId, qos, topic }) => ({ messageId, qos, topic })),
				[11, 12, 13, 14].map((messageId) => ({ messageId, qos: 1, topic: 'Topic/a' }))
			);
			for (const publish of publishes) assert.deepStrictEqual(JSON.parse(publish.payload), message);
			socket.handlers.close?.();
		});
	}

	/** A connected MQTT session over a fake WebSocket, with every `acknowledged` event's packet collected. */
	async function connectedClient(clientId) {
		const { listener, server } = mqttWebSocketListener();
		const socket = fakeWebSocket();
		const acknowledged = [];
		server.mqtt.events.on('acknowledged', (session, packet) => acknowledged.push(packet));
		listener(socket, mqttUpgradeRequest(), Promise.resolve({ status: 200 }), () => {});
		socket.handlers.message(
			generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId, clean: true })
		);
		await waitFor(() => server.mqtt.sessions.size === 1);
		return { socket, acknowledged };
	}

	it('reads a run of acknowledgements without the general parser, into the packets the parser emits for them', async () => {
		const { socket, acknowledged } = await connectedClient('acknowledgement-run');
		const acknowledgements = Buffer.concat([
			generate({ cmd: 'puback', messageId: 5 }),
			generate({ cmd: 'pubrec', messageId: 6 }),
			generate({ cmd: 'pubrel', messageId: 7 }),
			generate({ cmd: 'pubcomp', messageId: 300 }),
		]);
		assert.strictEqual(acknowledgements.length, 16, 'four 4-byte acknowledgements');
		const parsed = [];
		const parser = mqttPacket.parser({ protocolVersion: 5 });
		parser.on('packet', (packet) => parsed.push({ ...packet }));
		parser.parse(acknowledgements);
		const sentBefore = socket.sent.length;
		socket.handlers.message(acknowledgements);
		await waitFor(() => acknowledged.length === 2);
		// PUBACK and PUBCOMP complete a delivery; PUBREC is answered with a PUBREL, and PUBREL with a PUBCOMP
		assert.deepStrictEqual(
			acknowledged.map((packet) => ({ ...packet })),
			[parsed[0], parsed[3]]
		);
		await waitFor(() => socket.sent.length >= sentBefore + 2);
		assert.deepStrictEqual(
			socket.sent.slice(sentBefore).map((packet) => Buffer.from(packet)),
			[generate({ cmd: 'pubrel', messageId: 6 }), generate({ cmd: 'pubcomp', messageId: 7 })]
		);
		socket.handlers.close?.();
	});

	it('parses data that continues a partial packet with the general parser, though it looks like PUBACKs', async () => {
		const { socket, acknowledged } = await connectedClient('puback-lookalike');
		// a PINGREQ answered proves the parser read the PUBLISH whole, its payload included
		const publish = generate({ cmd: 'publish', topic: 'NoSuchTopic/a', payload: Buffer.from([0x40, 2, 0, 9]), qos: 0 });
		socket.handlers.message(publish.subarray(0, publish.length - 4));
		socket.handlers.message(publish.subarray(publish.length - 4));
		socket.handlers.message(generate({ cmd: 'pingreq' }));
		await waitFor(() => socket.sent.some((packet) => packet[0] >> 4 === 13), { message: 'PINGRESP' });
		assert.deepStrictEqual(acknowledged, [], 'the PUBLISH payload is not read as a PUBACK');
		socket.handlers.close?.();
	});

	it('parses the body of a packet whose fixed header came alone with the general parser, though it looks like PUBACKs', async () => {
		const { socket, acknowledged } = await connectedClient('puback-split-header');
		// a v5 PUBACK with a reason code and empty properties, its body shaped like a 4-byte PUBACK
		const puback = generate({ cmd: 'puback', messageId: 0x4002, reasonCode: 0x10 }, { protocolVersion: 5 });
		assert.deepStrictEqual([...puback], [0x40, 4, 0x40, 2, 0x10, 0]);
		socket.handlers.message(puback.subarray(0, 2));
		socket.handlers.message(puback.subarray(2));
		socket.handlers.message(generate({ cmd: 'pingreq' }));
		await waitFor(() => socket.sent.some((packet) => packet[0] >> 4 === 13), { message: 'PINGRESP' });
		assert.deepStrictEqual(
			acknowledged.map(({ messageId }) => messageId),
			[0x4002]
		);
		socket.handlers.close?.();
	});

	it('returns from the MQTT delivery listener without a promise unless the socket is backed up', async () => {
		const { listener, server } = mqttWebSocketListener();
		const socket = fakeWebSocket();
		const { rawSocket, sent } = socket;
		listener(socket, mqttUpgradeRequest(), Promise.resolve({ status: 200 }), () => {});
		socket.handlers.message(
			generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId: 'sync-listener', clean: true })
		);
		await waitFor(() => server.mqtt.sessions.size === 1);
		const [session] = server.mqtt.sessions;
		const deliver = (value) => session.listener('Topic/a', { value }, 1, { qos: 0 }, value);

		assert.strictEqual(deliver(1), true);
		rawSocket.writableNeedDrain = true;
		const backedUp = deliver(2);
		assert.strictEqual(typeof backedUp?.then, 'function', 'a backed-up socket is waited on');
		rawSocket.writableNeedDrain = false;
		rawSocket.emit('drain');
		await backedUp;
		assert.strictEqual(sent.filter((packet) => packet[0] >> 4 === 3).length, 2);
		socket.handlers.close?.();
	});
});
