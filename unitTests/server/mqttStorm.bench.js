/**
 * Benchmark: main-thread CPU and wall time for MQTT storms through the real MQTT WebSocket listener
 * (server/mqtt.ts) and subscription sessions, with sockets that only count what is sent:
 * - snapshot: connected clients all subscribe at once to `#` on a table of retained records (an MQTT
 *   retained message is a table record), so each receives every record.
 * - reconnect: durable QoS 1 clients disconnect, records are written while they are away, and they all
 *   reconnect at once, each resuming its session and replaying what it missed.
 * Run via: npm run build && npx mocha unitTests/server/mqttStorm.bench.js
 * MQTT_STORM_BENCH_SCENARIOS (comma list of snapshot, reconnect), _CONNECTIONS (comma list), _RECORDS,
 * _QOS (snapshot only; reconnect is QoS 1), _OUT (append one JSON row per measurement, for A/B runs).
 */
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { transaction } = require('#src/resources/transaction');
const { handleApplication } = require('#src/server/mqtt');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { generate } = require('mqtt-packet');
const { EventEmitter } = require('node:events');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

const SCENARIOS = (process.env.MQTT_STORM_BENCH_SCENARIOS ?? 'snapshot,reconnect').split(',');
const CONNECTION_COUNTS = (process.env.MQTT_STORM_BENCH_CONNECTIONS ?? '100,1000').split(',').map(Number);
const RECORDS = Number(process.env.MQTT_STORM_BENCH_RECORDS ?? 100);
const QOS = Number(process.env.MQTT_STORM_BENCH_QOS ?? 0);
const user = { username: 'mqtt-storm-bench', role: { permission: { super_user: true } } };

const CONNACK = 2;
const PUBLISH = 3;
const SUBACK = 9;

function mqttListener() {
	let listener;
	const server = {
		ws: (fn) => ((listener = fn), []),
		socket: () => ({}),
		mqtt: { sessions: new Set(), events: new EventEmitter() },
	};
	handleApplication({ options: { getAll: () => ({ webSocket: {} }) }, server });
	return (counter) => {
		const rawSocket = new EventEmitter();
		rawSocket.remoteAddress = '127.0.0.1';
		const socket = { handlers: {}, _socket: rawSocket, pendingAcks: [] };
		socket.close = () => {};
		socket.terminate = () => {};
		socket.send = (packet) => {
			const type = packet[0] >> 4;
			if (type === PUBLISH) {
				if (++counter.delivered === counter.target) counter.reached();
				// a QoS 1 delivery is acknowledged within the turn, as a prompt client would
				if (packet[0] & 0x06 && socket.pendingAcks.push(packetId(packet)) === 1) {
					setImmediate(() => flushAcks(socket));
				}
			} else if (type === SUBACK) counter.subacks++;
			else if (type === CONNACK) counter.connacks++;
		};
		socket.on = (event, handler) => (socket.handlers[event] = handler);
		const headers = { 'sec-websocket-protocol': 'mqtt' };
		const request = { headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] }, user };
		listener(socket, request, Promise.resolve({ status: 200 }), () => {});
		return socket;
	};
}

/** A QoS 1 PUBLISH carries its packet id right after the topic. */
function packetId(packet) {
	let offset = 1;
	while (packet[offset++] & 0x80);
	return packet.readUInt16BE(offset + 2 + packet.readUInt16BE(offset));
}

function flushAcks(socket) {
	const ids = socket.pendingAcks.splice(0);
	if (ids.length === 0 || !socket.handlers.message) return;
	const acks = Buffer.allocUnsafe(ids.length * 4);
	for (let i = 0; i < ids.length; i++) {
		acks[i * 4] = 0x40; // PUBACK
		acks[i * 4 + 1] = 2;
		acks.writeUInt16BE(ids[i], i * 4 + 2);
	}
	socket.handlers.message(acks);
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const cpuMicros = () => {
	const { user, system } = process.cpuUsage();
	return user + system;
};
const heapUsed = () => {
	global.gc();
	global.gc();
	return process.memoryUsage().heapUsed;
};

function newCounter() {
	return { delivered: 0, subacks: 0, connacks: 0, target: 0, reached: null };
}
/** Resolves once `target` deliveries have arrived. */
function deliveries(counter, target) {
	if (counter.delivered >= target) return;
	counter.target = target;
	return new Promise((resolve) => (counter.reached = resolve));
}

describe('MQTT storms', function () {
	this.timeout(600_000);
	let open;
	let tableCount = 0;
	const results = [];
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		open = mqttListener();
	});
	after(() => {
		console.log(`\nMQTT storms (${RECORDS} records)`);
		console.table(results);
	});

	function createTable() {
		const name = `MqttStorm${++tableCount}`;
		const T = table({
			database: 'mqttstormbench',
			table: name,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		Resources.resources.set(name, T, { mqtt: true });
		return { T, name };
	}

	async function writeRecords(T, round) {
		// committed in batches: the writes are setup here, not what is measured
		for (let i = 0; i < RECORDS; i += 100) {
			await transaction({}, async (context) => {
				for (let j = i; j < Math.min(i + 100, RECORDS); j++) {
					await T.put(`r${j}`, { value: round * RECORDS + j, reading: { a: 1, b: 'two', c: [3, 4, 5] } }, context);
				}
			});
		}
	}

	function connect(counter, clientId, clean) {
		const socket = open(counter);
		socket.handlers.message(generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId, clean }));
		return socket;
	}

	function record(row) {
		results.push(row);
		if (process.env.MQTT_STORM_BENCH_OUT) {
			require('node:fs').appendFileSync(process.env.MQTT_STORM_BENCH_OUT, JSON.stringify(row) + '\n');
		}
	}

	for (const connections of CONNECTION_COUNTS) {
		if (SCENARIOS.includes('snapshot')) {
			it(`snapshot: ${connections} connections subscribe at once to ${RECORDS} retained records`, async () => {
				const { T, name } = createTable();
				await writeRecords(T, 0);
				const counter = newCounter();
				const sockets = [];
				for (let c = 0; c < connections; c++) {
					sockets.push(connect(counter, `snapshot-${tableCount}-${c}`, true));
					if (c % 100 === 0) await settle();
				}
				await waitFor(() => counter.connacks === connections, 60_000);
				const heapBefore = heapUsed();
				const expected = connections * RECORDS;
				const startCpu = cpuMicros();
				const startTime = performance.now();
				const subscribe = generate({
					cmd: 'subscribe',
					messageId: 1,
					subscriptions: [{ topic: `${name}/#`, qos: QOS }],
				});
				for (const socket of sockets) socket.handlers.message(subscribe);
				await deliveries(counter, expected);
				const elapsed = performance.now() - startTime;
				const cpu = cpuMicros() - startCpu;
				record({
					'scenario': 'snapshot',
					connections,
					'qos': QOS,
					'deliveries': counter.delivered,
					'µs/delivery': +(cpu / counter.delivered).toFixed(3),
					'wall ms': Math.round(elapsed),
					'B/subscription': Math.round((heapUsed() - heapBefore) / connections),
				});
				for (const socket of sockets) socket.handlers.close?.();
				await settle();
			});
		}

		if (SCENARIOS.includes('reconnect')) {
			it(`reconnect: ${connections} durable QoS 1 sessions resume at once, replaying ${RECORDS} records each`, async () => {
				const { T, name } = createTable();
				await T.put('seed', { value: 0 });
				const clientIds = Array.from({ length: connections }, (_, c) => `reconnect-${tableCount}-${c}`);
				let counter = newCounter();
				let sockets = [];
				for (const clientId of clientIds) {
					sockets.push(connect(counter, clientId, false));
					if (sockets.length % 100 === 0) await settle();
				}
				await waitFor(() => counter.connacks === connections, 60_000);
				const subscribe = generate({
					cmd: 'subscribe',
					messageId: 1,
					subscriptions: [{ topic: `${name}/#`, qos: 1 }],
				});
				for (const socket of sockets) socket.handlers.message(subscribe);
				await waitFor(() => counter.subacks === connections, 60_000);
				// a delivery acknowledged by every session, so each has a certified position to resume from
				await T.put('seed', { value: 1 });
				await deliveries(counter, connections * 2);
				await new Promise((resolve) => setTimeout(resolve, 200));
				for (const socket of sockets) socket.handlers.close?.();
				await new Promise((resolve) => setTimeout(resolve, 200));

				await writeRecords(T, 1);
				counter = newCounter();
				const expected = connections * RECORDS;
				const startCpu = cpuMicros();
				const startTime = performance.now();
				sockets = clientIds.map((clientId) => connect(counter, clientId, false));
				await waitFor(() => counter.connacks === connections, { timeout: 120_000, interval: 1 });
				const connected = performance.now() - startTime;
				await deliveries(counter, expected);
				const elapsed = performance.now() - startTime;
				const cpu = cpuMicros() - startCpu;
				record({
					'scenario': 'reconnect',
					connections,
					'qos': 1,
					'deliveries': counter.delivered,
					'µs/delivery': +(cpu / counter.delivered).toFixed(3),
					'ms to all CONNACKs': Math.round(connected),
					'wall ms': Math.round(elapsed),
				});
				for (const socket of sockets) socket.handlers.close?.();
				await new Promise((resolve) => setTimeout(resolve, 200));
			});
		}
	}
});
