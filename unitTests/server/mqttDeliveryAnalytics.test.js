'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { handleApplication } = require('#src/server/mqtt');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const analytics = require('#src/resources/analytics/write');
const { generate } = require('mqtt-packet');
const { waitFor } = require('../waitFor');
require('#src/server/serverHelpers/serverUtilities');

const PUBLISH = 3;
const PUBACK = 4;
const PUBREC = 5;
const user = { username: 'mqtt-delivery-analytics', role: { permission: { super_user: true } } };

const entries = [];

describe('MQTT delivery analytics', function () {
	this.timeout(30_000);
	let removeListener;
	let wasEnabled;
	let open;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
		wasEnabled = analytics.checkAnalyticsEnabled(false);
		removeListener = analytics.addAnalyticsListener((metrics) => {
			for (const entry of metrics) if (entry.metric === 'bytes-sent' && entry.type === 'mqtt') entries.push(entry);
		});
		let listener;
		handleApplication({
			options: { getAll: () => ({ webSocket: {} }) },
			server: {
				ws: (fn) => ((listener = fn), []),
				socket: () => ({}),
				mqtt: { sessions: new Set(), events: new EventEmitter() },
			},
		});
		open = (clientId) => {
			const rawSocket = new EventEmitter();
			rawSocket.remoteAddress = '127.0.0.1';
			const socket = { handlers: {}, _socket: rawSocket, published: [], acknowledged: [], subacked: false };
			socket.close = socket.terminate = () => {};
			socket.send = (packet) => {
				const type = packet[0] >> 4;
				if (type === PUBLISH) socket.published.push(packet);
				else if (type === PUBACK || type === PUBREC) socket.acknowledged.push(packet);
				else if (type === 9) socket.subacked = true;
			};
			socket.on = (event, handler) => (socket.handlers[event] = handler);
			const headers = { 'sec-websocket-protocol': 'mqtt' };
			const request = { headers: { asObject: headers, get: (name) => headers[name.toLowerCase()] }, user };
			listener(socket, request, Promise.resolve({ status: 200 }), () => {});
			socket.handlers.message(
				generate({ cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clientId, clean: true })
			);
			return socket;
		};
	});

	after(() => {
		removeListener?.();
		if (wasEnabled !== undefined) analytics.setAnalyticsEnabled(wasEnabled);
	});

	it('records each subscriber delivery under the topic and QoS', async () => {
		const name = 'MqttDeliveryAnalytics';
		const T = table({
			table: name,
			database: 'mqtt_delivery_analytics',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		Resources.resources.set(name, T, { mqtt: true });
		analytics.setAnalyticsEnabled(true);
		const subscribers = [0, 0, 1].map((qos, i) => {
			const socket = open(`delivery-analytics-${i}`);
			socket.qos = qos;
			socket.handlers.message(
				generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: `${name}/t0`, qos, rh: 2 }] })
			);
			return socket;
		});
		await waitFor(() => subscribers.every((socket) => socket.subacked));
		for (let i = 0; i < 3; i++) await T.publish('t0', { value: 'x'.repeat(i * 10) });
		await waitFor(() => subscribers.every((socket) => socket.published.length === 3));
		const lengths = (qos) =>
			subscribers.filter((socket) => socket.qos === qos).flatMap((socket) => socket.published.map((p) => p.length));
		const qos0 = await reported(name, 'publish', lengths(0).length);
		const qos1 = await reported(name, 'publish,qos=1', lengths(1).length);
		assert.deepStrictEqual({ count: qos0.count, mean: qos0.mean }, expected(lengths(0)));
		assert.deepStrictEqual({ count: qos1.count, mean: qos1.mean }, expected(lengths(1)));
		for (const socket of subscribers) socket.handlers.close?.();
	});

	it("records a publish's acknowledgement under its topic's first level, not the device's topic", async () => {
		const name = 'MqttAckAnalytics';
		const T = table({
			table: name,
			database: 'mqtt_delivery_analytics',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		Resources.resources.set(name, T, { mqtt: true });
		analytics.setAnalyticsEnabled(true);
		const publisher = open('ack-analytics');
		const sends = [
			[`${name}/device-a`, 1, 11],
			[`${name}/device-b`, 1, 12],
			[`${name}/device-c`, 2, 13],
		];
		for (const [topic, qos, messageId] of sends)
			publisher.handlers.message(generate({ cmd: 'publish', topic, qos, messageId, payload: '{"value":1}' }));
		await waitFor(() => publisher.acknowledged.length === sends.length);
		const ackLengths = (type) =>
			publisher.acknowledged.filter((packet) => packet[0] >> 4 === type).map((packet) => packet.length);
		const puback = await reported(name, 'puback', 2);
		const pubrec = await reported(name, 'pubrec', 1);
		assert.deepStrictEqual(puback, expected(ackLengths(PUBACK)));
		assert.deepStrictEqual(pubrec, expected(ackLengths(PUBREC)));
		assert.ok(!entries.some((entry) => entry.path?.startsWith?.(`${name}/`)), 'no action is keyed by a device topic');
		publisher.handlers.close?.();
	});

	it('records an acknowledgement under the first level when analytics turns on while its publish is pending', async () => {
		const name = 'MqttAckTurnedOn';
		const T = table({
			table: name,
			database: 'mqtt_delivery_analytics',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		Resources.resources.set(name, T, { mqtt: true });
		const publisher = open('ack-turned-on');
		// once the session is up, a packet is received in the call that hands it over
		publisher.handlers.message(
			generate({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: `${name}/none`, qos: 0 }] })
		);
		await waitFor(() => publisher.subacked);
		analytics.setAnalyticsEnabled(false);
		publisher.handlers.message(
			generate({ cmd: 'publish', topic: `${name}/device-a`, qos: 1, messageId: 21, payload: '{"value":1}' })
		);
		analytics.setAnalyticsEnabled(true);
		await waitFor(() => publisher.acknowledged.length === 1);
		const puback = await reported(name, 'puback', 1);
		assert.strictEqual(puback.count, 1);
		assert.ok(!entries.some((entry) => entry.method === 'puback' && entry.path === undefined));
		publisher.handlers.close?.();
	});
});

const expected = (lengths) => ({ count: lengths.length, mean: lengths.reduce((a, b) => a + b) / lengths.length });

/** bytes-sent for a path and method, summed across reports (a run can straddle a flush), once `count` have arrived */
function reported(path, method, count) {
	const sum = () => {
		let samples = 0;
		let total = 0;
		for (const entry of entries) {
			if (entry.path !== path || entry.method !== method) continue;
			samples += entry.count;
			total += entry.mean * entry.count;
		}
		return { count: samples, mean: samples ? total / samples : undefined };
	};
	return waitFor(() => (sum().count >= count ? sum() : undefined), {
		timeout: 10_000,
		message: `a report carried bytes-sent for ${method}`,
	});
}
