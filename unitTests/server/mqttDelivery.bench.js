/**
 * CPU per live QoS 0 delivery: MQTT_DELIVERY_BENCH_SESSIONS clean sessions each subscribe to one exact topic,
 * then MQTT_DELIVERY_BENCH_WRITES messages are published to it, one commit each, each fanned out to every
 * session before the next is written, so every queue is at most one deep, as at a steady rate below the
 * subscribers' capacity. Two fixtures:
 *
 *   - listener: sessions from getSession() whose listener only counts, so what is measured stops at the
 *     session's call to its listener (commit notification, per-subscription events, queue, drain);
 *   - socket: connections through mqtt.ts's WebSocket listener to sockets that only count, adding the shared
 *     payload encoding, PUBLISH framing and the per-packet analytics.
 *
 * µs/delivery is (CPU of the timed writes - CPU of the same writes with nobody subscribed) / deliveries, for
 * the main thread (`thread µs/delivery`, the thread delivery runs on) and the whole process, each the median
 * of MQTT_DELIVERY_BENCH_REPEATS timed runs of the writes, so a run the scheduler disturbed (another process
 * on the core, a move to an efficiency core) does not decide the result. A manual run, not part of CI:
 *
 *   npm run build && npx mocha unitTests/server/mqttDelivery.bench.js
 *
 * MQTT_DELIVERY_BENCH_FIXTURE picks one fixture (listener or socket; both by default), and
 * MQTT_DELIVERY_BENCH_OUT appends each result as a JSON line. MQTT_DELIVERY_BENCH_QOS=1 subscribes the listener
 * fixture's clean sessions at QoS 1, each acknowledging its deliveries on the next turn, as a client's PUBACKs
 * read off a socket would arrive; the socket fixture runs only at QoS 0.
 *
 * MQTT_DELIVERY_BENCH_BURST=n publishes n messages at once at each step, so several commits reach one notify pass
 * and every queue is up to n deep before the drain runs; MQTT_DELIVERY_BENCH_SUSTAINED=1 publishes the steps back
 * to back, waiting for each step's commits but for the deliveries only once all are written. The `max queued`
 * column is the deepest queue one session saw in the warm-up (listener fixture only).
 */
// set before anything loads server/liveSubscriptionAuth, which reads it once: the bench user has no hdb_user
// record, so the 30 s live-subscription recheck would revoke its subscriptions in any run that lasts longer
process.env.HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS ??= String(24 * 60 * 60 * 1000);
const assert = require('node:assert');
const { appendFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { handleApplication } = require('#src/server/mqtt');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { generate } = require('mqtt-packet');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const SESSIONS = (process.env.MQTT_DELIVERY_BENCH_SESSIONS ?? '1000,5000').split(',').map(Number);
const WRITES = Number(process.env.MQTT_DELIVERY_BENCH_WRITES ?? 200);
const REPEATS = Number(process.env.MQTT_DELIVERY_BENCH_REPEATS ?? 7);
const QOS = Number(process.env.MQTT_DELIVERY_BENCH_QOS ?? 0);
const BURST = Number(process.env.MQTT_DELIVERY_BENCH_BURST ?? 1);
const SUSTAINED = process.env.MQTT_DELIVERY_BENCH_SUSTAINED === '1';
const FIXTURES = process.env.MQTT_DELIVERY_BENCH_FIXTURE
	? [process.env.MQTT_DELIVERY_BENCH_FIXTURE]
	: ['listener', 'socket'];
const user = { username: 'mqtt-delivery-bench', role: { permission: { super_user: true } } };
const PUBLISH = 3;
const SUBACK = 9;

const settle = () => new Promise((resolve) => setImmediate(resolve));
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const cpu = () => {
	const thread = process.threadCpuUsage();
	const all = process.cpuUsage();
	return { thread: thread.user + thread.system, process: all.user + all.system };
};

/** Counts deliveries, and resolves `reached` once `target` of them have arrived. */
function deliveryCounter() {
	const counter = { delivered: 0, target: 0, reached: null, probing: false, maxQueued: 0 };
	counter.deliver = () => {
		if (++counter.delivered === counter.target) counter.reached();
	};
	counter.until = (target) => {
		if (counter.delivered >= target) return;
		counter.target = target;
		return new Promise((resolve) => (counter.reached = resolve));
	};
	return counter;
}

async function listenerSessions(name, count, counter) {
	const sessions = [];
	for (let i = 0; i < count; i++) {
		const session = await getSession({ clientId: `delivery-${name}-${i}`, user, clean: true });
		const unacknowledged = [];
		const acknowledge = () => {
			for (const messageId of unacknowledged) session.acknowledge(messageId);
			unacknowledged.length = 0;
		};
		const probed = i === 0;
		session.setListener((topic, message, messageId) => {
			counter.deliver();
			if (probed && counter.probing) {
				const queued = (session.subscriptions[0]?.queue?.length ?? 0) + 1;
				if (queued > counter.maxQueued) counter.maxQueued = queued;
			}
			if (QOS > 0 && unacknowledged.push(messageId) === 1) setImmediate(acknowledge);
			return true;
		});
		await session.addSubscription({ topic: `${name}/t0`, qos: QOS, rh: 2 }, QOS > 0);
		sessions.push(session);
	}
	return () => {
		for (const session of sessions) session.disconnect(true);
	};
}

async function socketSessions(name, count, counter) {
	let listener;
	handleApplication({
		options: { getAll: () => ({ webSocket: {} }) },
		server: {
			ws: (fn) => ((listener = fn), []),
			socket: () => ({}),
			mqtt: { sessions: new Set(), events: new EventEmitter() },
		},
	});
	const headers = { 'sec-websocket-protocol': 'mqtt' };
	const request = { headers: { asObject: headers, get: (header) => headers[header.toLowerCase()] }, user };
	let subacks = 0;
	const sockets = [];
	for (let i = 0; i < count; i++) {
		const rawSocket = new EventEmitter();
		rawSocket.remoteAddress = '127.0.0.1';
		const socket = { handlers: {}, _socket: rawSocket, close() {}, terminate() {} };
		socket.send = (packet) => {
			const type = packet[0] >> 4;
			if (type === PUBLISH) counter.deliver();
			else if (type === SUBACK) subacks++;
		};
		socket.on = (event, handler) => (socket.handlers[event] = handler);
		listener(socket, request, Promise.resolve({ status: 200 }), () => {});
		socket.handlers.message(
			generate({
				cmd: 'connect',
				protocolId: 'MQTT',
				protocolVersion: 4,
				clientId: `delivery-${name}-${i}`,
				clean: true,
			})
		);
		sockets.push(socket);
		if (i % 100 === 0) await settle();
	}
	await settle();
	for (let i = 0; i < count; i++) {
		sockets[i].handlers.message(
			generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: `${name}/t0`, qos: 0, rh: 2 }] })
		);
		if (i % 100 === 0) await settle();
	}
	await waitFor(() => subacks === count, 60_000);
	return () => {
		for (const socket of sockets) socket.handlers.close();
	};
}

describe('MQTT live QoS 0 delivery to one exact topic (bench)', function () {
	this.timeout(600_000);
	let tables = 0;
	const results = [];
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});
	after(() => console.table(results));

	/**
	 * Publishes `WRITES` messages, `BURST` at a time, each step delivered everywhere before the next unless
	 * `SUSTAINED`; returns the CPU it took.
	 */
	async function publishAll(T, counter, subscribers) {
		const start = cpu();
		const startDelivered = counter.delivered;
		for (let i = 0; i < WRITES;) {
			const step = [];
			for (const end = Math.min(i + BURST, WRITES); i < end; i++)
				step.push(T.publish('t0', { value: i, sentAt: Date.now(), reading: { a: 1, b: 'two', c: [3, 4, 5] } }));
			await Promise.all(step);
			if (!SUSTAINED) await counter.until(startDelivered + i * subscribers);
		}
		await counter.until(startDelivered + WRITES * subscribers);
		const end = cpu();
		return { thread: end.thread - start.thread, process: end.process - start.process };
	}
	/** The median CPU of `REPEATS` runs of publishAll(). */
	async function publishRepeatedly(T, counter, subscribers) {
		const runs = [];
		for (let run = 0; run < REPEATS; run++) {
			global.gc?.();
			runs.push(await publishAll(T, counter, subscribers));
		}
		return { thread: median(runs.map((run) => run.thread)), process: median(runs.map((run) => run.process)) };
	}

	for (const fixture of QOS > 0 ? FIXTURES.filter((fixture) => fixture === 'listener') : FIXTURES) {
		for (const sessions of SESSIONS) {
			it(`${fixture}: ${sessions} sessions`, async () => {
				const name = `MqttDelivery${++tables}`;
				const T = table({
					database: 'mqttdeliverybench',
					table: name,
					audit: true,
					attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
				});
				Resources.resources.set(name, T, { mqtt: true });
				const counter = deliveryCounter();
				// the same writes with nobody subscribed: what is left over is the delivery
				await publishAll(T, counter, 0);
				const writesOnly = await publishRepeatedly(T, counter, 0);
				const end = await (fixture === 'socket' ? socketSessions : listenerSessions)(name, sessions, counter);
				counter.probing = true;
				await publishAll(T, counter, sessions); // warm up
				counter.probing = false;
				const before = counter.delivered;
				const used = await publishRepeatedly(T, counter, sessions);
				assert.strictEqual(counter.delivered - before, REPEATS * WRITES * sessions);
				const deliveries = WRITES * sessions;
				const result = {
					fixture,
					'qos': QOS,
					'burst': BURST,
					'sustained': SUSTAINED,
					sessions,
					'writes': WRITES,
					'repeats': REPEATS,
					'thread µs/delivery': +((used.thread - writesOnly.thread) / deliveries).toFixed(4),
					'process µs/delivery': +((used.process - writesOnly.process) / deliveries).toFixed(4),
					'write-only µs': +(writesOnly.thread / WRITES).toFixed(1),
					'max queued': counter.maxQueued,
				};
				results.push(result);
				if (process.env.MQTT_DELIVERY_BENCH_OUT)
					appendFileSync(process.env.MQTT_DELIVERY_BENCH_OUT, JSON.stringify(result) + '\n');
				end();
				await settle();
			});
		}
	}
});
