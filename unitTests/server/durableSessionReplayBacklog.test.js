const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const mqttPacket = require('mqtt-packet');
const { setupTestDBPath, ensureSystemTables } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { handleApplication } = require('#src/server/mqtt');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const isRocksDB = process.env.HARPER_STORAGE_ENGINE !== 'lmdb';
const v5 = { protocolVersion: 5 };
const PATCHES = 2880;

/** A WebSocket client of `server/mqtt.ts` that acknowledges the first `ackLimit` deliveries as an MQTT client would. */
function mqttListener(user) {
	let listener;
	const server = {
		ws: (fn) => ((listener = fn), []),
		socket: () => ({}),
		mqtt: { sessions: new Set(), events: new EventEmitter() },
	};
	handleApplication({ options: { getAll: () => ({ webSocket: {} }) }, server });
	const open = (ackLimit = Infinity) => {
		const parser = mqttPacket.parser(v5);
		const socket = { packets: [], handlers: {}, acked: 0, _socket: { remoteAddress: '127.0.0.1' } };
		const reply = (packet) => setImmediate(() => socket.handlers.message(mqttPacket.generate(packet, v5)));
		parser.on('packet', (packet) => {
			socket.packets.push(packet);
			if (packet.cmd === 'publish' && packet.qos > 0 && socket.acked < ackLimit) {
				socket.acked++;
				reply({ cmd: packet.qos === 1 ? 'puback' : 'pubrec', messageId: packet.messageId });
			} else if (packet.cmd === 'pubrel') reply({ cmd: 'pubcomp', messageId: packet.messageId });
		});
		socket.close = () => {};
		socket.terminate = () => {};
		socket.send = (message) => parser.parse(message);
		socket.on = (event, handler) => (socket.handlers[event] = handler);
		const headers = { 'sec-websocket-protocol': 'mqtt' };
		const request = { headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] }, user };
		listener(socket, request, Promise.resolve({ status: 200 }), () => {});
		return socket;
	};
	open.sessions = server.mqtt.sessions;
	return open;
}
const ofCommand = (socket, cmd) => socket.packets.filter((packet) => packet.cmd === cmd);
const delivered = (socket) => ofCommand(socket, 'publish').map((packet) => JSON.parse(packet.payload.toString()).n);

describe('MQTT durable sessions resuming across a long backlog of patches', function () {
	if (!isRocksDB) return;
	this.timeout(240_000);
	let open;
	let sessions;
	let sequence = 0;
	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		// a principal with an hdb_user record, which the periodic re-authorization keeps
		await ensureSystemTables();
		open = mqttListener(await require('#src/security/user').findAndValidateUser('admin', undefined, false));
		sessions = open.sessions;
	});

	for (const qos of [1, 2]) {
		for (const shape of ['record', 'wildcard']) {
			it(`delivers ${PATCHES} patches to one record in order at QoS ${qos} (${shape} topic), resuming after a disconnect`, async () => {
				const name = `BacklogTopic${++sequence}`;
				const T = table({
					table: name,
					database: `backlog_${name}`,
					audit: true,
					attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
				});
				Resources.resources.set(name, T, { mqtt: true });
				const topic = shape === 'record' ? `${name}/a` : `${name}/#`;
				const clientId = `backlog-${name}`;
				const stored = async () => (await databases.system.hdb_durable_session.get(clientId))?.subscriptions?.[0];
				const connect = async (ackLimit) => {
					const socket = open(ackLimit);
					socket.handlers.message(
						mqttPacket.generate({ cmd: 'connect', protocolId: 'MQTT', clientId, clean: false, ...v5 }, v5)
					);
					await waitFor(() => ofCommand(socket, 'connack').length > 0);
					return socket;
				};
				const disconnect = (socket) => {
					socket.handlers.message(mqttPacket.generate({ cmd: 'disconnect' }, v5));
					socket.handlers.close?.();
				};
				await T.put('a', { n: 0 });
				const first = await connect();
				first.handlers.message(
					mqttPacket.generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic, qos }] }, v5)
				);
				await waitFor(() => ofCommand(first, 'suback').length > 0);
				await T.patch('a', { n: 0.5 });
				await waitFor(() => delivered(first).includes(0.5));
				await waitFor(async () => (await stored())?.databaseGeneration !== undefined);
				disconnect(first);

				for (let n = 1; n <= PATCHES; n++) await T.patch('a', { n });

				// within what a resume that has not verified yet keeps as receipts, for QoS 1 and 2
				const acknowledged = 400;
				const second = await connect(acknowledged);
				await waitFor(() => delivered(second).length >= acknowledged, { timeout: 60_000 });
				assert.deepStrictEqual(
					delivered(second).slice(0, acknowledged),
					Array.from({ length: acknowledged }, (_, i) => i + 1)
				);
				const session = [...sessions].find((session) => session.sessionId === clientId);
				await waitFor(() => session.receivedCount >= acknowledged);
				disconnect(second);

				const third = await connect();
				await waitFor(() => delivered(third).at(-1) === PATCHES, { timeout: 60_000 });
				assert.deepStrictEqual(
					delivered(third),
					Array.from({ length: PATCHES - acknowledged }, (_, i) => acknowledged + i + 1)
				);
				disconnect(third);
			});
		}
	}
});
