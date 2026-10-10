/**
 * Benchmark: main-thread CPU per MQTT delivery, and heap per subscription, through the real MQTT
 * WebSocket listener (server/mqtt.ts) and subscription sessions, with sockets that only count what is
 * sent. No network, no socket back-pressure: what is measured is the platform's own per-subscriber work
 * between a commit and the socket write.
 * Run via: npm run build && npx mocha unitTests/server/mqttFanout.bench.js
 * MQTT_FANOUT_BENCH_CONNECTIONS (comma list), _SUBS (subscriptions per connection), _TOPICS (records the
 * subscriptions spread over; 1 = every subscriber on one topic), _WRITES, _QOS, _WILDCARD (1: every
 * subscriber uses one mid-level `+` pattern that every write matches; device: each topic's subscribers use
 * `+/<topic>`, so a write matches only its topic's subscribers, as clients following one device across
 * sites do), _INFLIGHT (writes committed before waiting) and
 * _CLOSED=1 (wait for each batch's deliveries before the next, so subscriber queues stay at most _INFLIGHT
 * deep, as at a steady rate; otherwise writes outrun delivery and queues back up, as in a burst), _PAYLOAD
 * (bytes of filler added to each message), _SLOW (the share of connections whose socket reports
 * back-pressure after every write, draining _SLOW_MS later, as a slow consumer's does).
 * QoS 2 deliveries go through PUBREC, PUBREL and PUBCOMP; QoS 1 through PUBACK.
 */
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { handleApplication } = require('#src/server/mqtt');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { generate } = require('mqtt-packet');
const { EventEmitter } = require('node:events');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

const CONNECTION_COUNTS = (process.env.MQTT_FANOUT_BENCH_CONNECTIONS ?? '100,1000,5000').split(',').map(Number);
const SUBS = Number(process.env.MQTT_FANOUT_BENCH_SUBS ?? 1);
const TOPICS = Number(process.env.MQTT_FANOUT_BENCH_TOPICS ?? 1);
const WRITES = Number(process.env.MQTT_FANOUT_BENCH_WRITES ?? 200);
const QOS = Number(process.env.MQTT_FANOUT_BENCH_QOS ?? 0);
const WILDCARD = process.env.MQTT_FANOUT_BENCH_WILDCARD === '1';
const DEVICE_WILDCARD = process.env.MQTT_FANOUT_BENCH_WILDCARD === 'device';
const INFLIGHT = Number(process.env.MQTT_FANOUT_BENCH_INFLIGHT ?? 50);
// publish (a message), put (a whole record) or patch (part of one)
const WRITE = process.env.MQTT_FANOUT_BENCH_WRITE ?? 'publish';
const CLOSED = process.env.MQTT_FANOUT_BENCH_CLOSED === '1';
const PAYLOAD = Number(process.env.MQTT_FANOUT_BENCH_PAYLOAD ?? 0);
const FILLER = PAYLOAD > 0 ? 'x'.repeat(PAYLOAD) : undefined;
const SLOW = Number(process.env.MQTT_FANOUT_BENCH_SLOW ?? 0);
const SLOW_MS = Number(process.env.MQTT_FANOUT_BENCH_SLOW_MS ?? 5);
const user = { username: 'mqtt-fanout-bench', role: { permission: { super_user: true } } };

const PUBLISH = 3;
const PUBREL = 6;
const SUBACK = 9;

function mqttListener() {
	let listener;
	const server = {
		ws: (fn) => ((listener = fn), []),
		socket: () => ({}),
		mqtt: { sessions: new Set(), events: new EventEmitter() },
	};
	handleApplication({ options: { getAll: () => ({ webSocket: {} }) }, server });
	return (counter, slow = false) => {
		const rawSocket = new EventEmitter();
		rawSocket.remoteAddress = '127.0.0.1';
		const socket = { handlers: {}, _socket: rawSocket };
		socket.close = () => {};
		socket.terminate = () => {};
		socket.send = (packet) => {
			const type = packet[0] >> 4;
			if (type === PUBLISH) {
				if (++counter.delivered === counter.target) counter.reached();
				counter.bytes += packet.length;
				// a QoS 1/2 delivery is answered within the turn, as a prompt client would, so the session's
				// awaiting-acks map stays below its high-water mark; answers are 4-byte packets, one write per turn
				const qos = (packet[0] >> 1) & 3;
				if (qos > 0) queueAnswer(socket, qos === 1 ? 0x40 : 0x50, packetId(packet)); // PUBACK or PUBREC
			} else if (type === PUBREL)
				queueAnswer(socket, 0x70, packet.readUInt16BE(2)); // PUBCOMP
			else if (type === SUBACK) counter.subacks++;
			if (slow && !rawSocket.writableNeedDrain) {
				rawSocket.writableNeedDrain = true;
				setTimeout(() => {
					rawSocket.writableNeedDrain = false;
					rawSocket.emit('drain');
				}, SLOW_MS);
			}
		};
		socket.pendingAcks = [];
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
	let multiplier = 1;
	let remaining = 0;
	let byte;
	do {
		byte = packet[offset++];
		remaining += (byte & 0x7f) * multiplier;
		multiplier *= 128;
	} while (byte & 0x80);
	const topicLength = packet.readUInt16BE(offset);
	return packet.readUInt16BE(offset + 2 + topicLength);
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

describe('MQTT fan-out delivery cost', function () {
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
		console.log(
			`\nMQTT fan-out (${WRITES} ${WRITE}s, ${INFLIGHT} in flight${CLOSED ? ', closed loop' : ''}, subs/conn=${SUBS}, topics=${TOPICS}, qos=${QOS}${WILDCARD ? ', wildcard' : DEVICE_WILDCARD ? ', device wildcard' : ''}${PAYLOAD ? `, payload +${PAYLOAD} B` : ''}${SLOW ? `, ${SLOW * 100}% slow (${SLOW_MS} ms)` : ''})`
		);
		console.table(results);
	});

	function createTable() {
		const name = `MqttFanout${++tableCount}`;
		const T = table({
			database: 'mqttfanoutbench',
			table: name,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }, { name: 'sentAt' }],
		});
		Resources.resources.set(name, T, { mqtt: true });
		return { T, name };
	}

	/**
	 * Each write is its own commit, published round-robin over the topics. `delivered(i)` resolves once the
	 * first i writes' deliveries have arrived; it is awaited after each batch only in closed-loop mode.
	 */
	async function publishAll(T, delivered) {
		const writes = [];
		for (let i = 0; i < WRITES; i++) {
			const topic = i % TOPICS;
			// a numeric-looking topic level is parsed as a number key, so ids are kept non-numeric
			const id = WILDCARD ? `site/t${topic}/temp` : DEVICE_WILDCARD ? `site/t${topic}` : `t${topic}`;
			const data = { value: i, sentAt: Date.now(), reading: { a: 1, b: 'two', c: [3, 4, 5] }, filler: FILLER };
			writes.push(WRITE === 'patch' ? T.patch(id, { value: i, sentAt: data.sentAt }) : T[WRITE](id, data));
			if (writes.length >= INFLIGHT) {
				await Promise.all(writes);
				writes.length = 0;
				if (CLOSED && delivered) await delivered(i + 1);
			}
		}
		await Promise.all(writes);
	}

	async function measureWrites(T) {
		await publishAll(T); // warm up the publish path itself
		const start = cpuMicros();
		await publishAll(T);
		await settle();
		return cpuMicros() - start;
	}

	for (const connections of CONNECTION_COUNTS) {
		it(`${connections} connections × ${SUBS} subscriptions`, async function () {
			const { T, name } = createTable();
			const baselineCpu = await measureWrites(T);
			const counter = { delivered: 0, bytes: 0, subacks: 0, target: 0, reached: null };
			const heapBeforeConnect = heapUsed();
			const sockets = [];
			for (let c = 0; c < connections; c++) {
				const socket = open(counter, c < connections * SLOW);
				socket.handlers.message(
					generate({
						cmd: 'connect',
						protocolId: 'MQTT',
						protocolVersion: 4,
						clientId: `bench-${tableCount}-${c}`,
						clean: QOS === 0,
					})
				);
				sockets.push(socket);
				if (c % 100 === 0) await settle();
			}
			await settle();
			const heapAfterConnect = heapUsed();
			if (process.env.MQTT_FANOUT_BENCH_SNAPSHOT) {
				require('node:v8').writeHeapSnapshot(process.env.MQTT_FANOUT_BENCH_SNAPSHOT + '-connected.heapsnapshot');
			}
			let subscribers = 0;
			const subscribersPerTopic = new Array(TOPICS).fill(0);
			for (let c = 0; c < connections; c++) {
				const subscriptions = [];
				for (let s = 0; s < SUBS; s++) {
					const topic = (c * SUBS + s) % TOPICS;
					subscribersPerTopic[topic]++;
					subscriptions.push({
						topic: WILDCARD ? `${name}/site/+/temp` : DEVICE_WILDCARD ? `${name}/+/t${topic}` : `${name}/t${topic}`,
						qos: QOS,
						rh: 2,
					});
				}
				subscribers += subscriptions.length;
				sockets[c].handlers.message(generate({ cmd: 'subscribe', messageId: 1, subscriptions }));
				if (c % 100 === 0) await settle();
			}
			await waitFor(() => counter.subacks === connections, 60_000);
			const heapAfterSubscribe = heapUsed();
			if (process.env.MQTT_FANOUT_BENCH_SNAPSHOT) {
				// for a per-constructor breakdown of what subscribing retained, diff the two snapshots
				require('node:v8').writeHeapSnapshot(process.env.MQTT_FANOUT_BENCH_SNAPSHOT + '-subscribed.heapsnapshot');
				return;
			}

			// deliveries expected from the first `writes` writes
			const expectedAfter = (writes) => {
				let total = 0;
				for (let i = 0; i < writes; i++) total += WILDCARD ? subscribers : subscribersPerTopic[i % TOPICS];
				return total;
			};
			const expected = expectedAfter(WRITES);
			const delivered = (writes) => {
				const target = expectedAfter(writes);
				if (counter.delivered >= target) return;
				counter.target = target;
				return new Promise((resolve) => (counter.reached = resolve));
			};
			// warm up delivery
			await publishAll(T, delivered);
			await waitFor(() => counter.delivered >= expected, 120_000);
			ackAll(sockets);
			counter.delivered = 0;
			counter.bytes = 0;

			const startCpu = cpuMicros();
			const startTime = performance.now();
			await publishAll(T, delivered);
			await waitFor(() => counter.delivered >= expected, { timeout: 120_000, interval: 1 });
			const elapsed = performance.now() - startTime;
			const cpu = cpuMicros() - startCpu;
			ackAll(sockets);

			const row = {
				connections,
				'subscriptions': subscribers,
				'deliveries': counter.delivered,
				'µs/delivery': +((cpu - baselineCpu) / counter.delivered).toFixed(3),
				'ms/write': +(cpu / WRITES / 1000).toFixed(3),
				'write-only µs': +(baselineCpu / WRITES).toFixed(1),
				'wall ms': Math.round(elapsed),
				'B/connection': Math.round((heapAfterConnect - heapBeforeConnect) / connections),
				'B/subscription': Math.round((heapAfterSubscribe - heapAfterConnect) / subscribers),
			};
			results.push(row);
			// for A/B runs across builds: one JSON row per measurement
			if (process.env.MQTT_FANOUT_BENCH_OUT) {
				require('node:fs').appendFileSync(process.env.MQTT_FANOUT_BENCH_OUT, JSON.stringify(row) + '\n');
			}
			for (const socket of sockets) socket.handlers.close?.();
			await settle();
		});
	}
});

/** Queues a 4-byte answer (PUBACK, PUBREC or PUBCOMP) for the socket's next flush. */
function queueAnswer(socket, firstByte, id) {
	if (socket.pendingAcks.push(firstByte, id) === 2) setImmediate(() => flushAcks(socket));
}

function flushAcks(socket) {
	const answers = socket.pendingAcks.splice(0);
	if (answers.length === 0 || !socket.handlers.message) return;
	const packets = Buffer.allocUnsafe(answers.length * 2);
	for (let i = 0; i < answers.length; i += 2) {
		packets[i * 2] = answers[i];
		packets[i * 2 + 1] = 2;
		packets.writeUInt16BE(answers[i + 1], i * 2 + 2);
	}
	socket.handlers.message(packets);
}

function ackAll(sockets) {
	for (const socket of sockets) flushAcks(socket);
}
