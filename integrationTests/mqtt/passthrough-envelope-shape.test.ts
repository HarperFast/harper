/**
 * A stored record with attributes named `contentType` and `data` is delivered verbatim only when `data` is
 * text or bytes, as a stored non-JSON payload is. With object or number `data` it is an ordinary record. It
 * used to reach mqtt-packet as it was, which threw; the listener then aborted the socket, and a durable
 * QoS 1/2 session that had already recorded the delivery replayed it, and aborted again, on every reconnect.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/mqtt/passthrough-envelope-shape.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { encode as cborEncode } from 'cbor-x';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'passthrough-envelope-shape');
// takeover closes an older connection on the same thread, so every connection lands on one
const CONFIG = { threads: { count: 1 } };
const CONTENT_TYPE = 'text/x-custom';
// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun, the same skip the sibling suites carry
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

type Delivery = { topic: string; payload: Buffer };

suite('Records shaped like a pass-through envelope', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let mqttURL = '';

	function connect(clientId: string, protocolVersion: 4 | 5, onMessage: (delivery: Delivery) => void) {
		return new Promise<{ mqttClient: MqttClient; sessionPresent: boolean; closed: () => boolean }>(
			(resolvePromise, reject) => {
				const mqttClient = mqtt.connect(mqttURL, {
					protocolVersion,
					reconnectPeriod: 0,
					connectTimeout: 8_000,
					clean: false,
					clientId,
					username: ctx.harper.admin.username,
					password: ctx.harper.admin.password,
				});
				let closed = false;
				// attached before CONNACK: a resumed session replays the moment it is accepted
				mqttClient.on('message', (topic, payload) => onMessage({ topic, payload }));
				mqttClient.on('close', () => (closed = true));
				const timer = setTimeout(() => reject(new Error(`connect timed out for ${clientId}`)), 10_000);
				mqttClient.once('connect', (connack) => {
					clearTimeout(timer);
					mqttClient.on('error', () => {});
					resolvePromise({ mqttClient, sessionPresent: connack.sessionPresent, closed: () => closed });
				});
				mqttClient.once('error', (error) => {
					clearTimeout(timer);
					mqttClient.end(true);
					reject(error);
				});
			}
		);
	}

	function subscribe(mqttClient: MqttClient, topic: string, qos: 1 | 2) {
		return new Promise<void>((resolvePromise, reject) => {
			mqttClient.subscribe(topic, { qos, rh: 2 }, (error) => (error ? reject(error) : resolvePromise()));
		});
	}

	function end(mqttClient: MqttClient | undefined) {
		return new Promise<void>((resolvePromise) => {
			if (!mqttClient) return resolvePromise();
			const timer = setTimeout(resolvePromise, 3_000);
			mqttClient.end(false, {}, () => {
				clearTimeout(timer);
				resolvePromise();
			});
		});
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 8_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await sleep(30);
		}
		return predicate();
	}

	async function putItem(id: string, data: unknown) {
		const response = await fetch(`${ctx.harper.httpURL}/Item/${id}`, {
			method: 'PUT',
			headers: { ...client.headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, contentType: CONTENT_TYPE, data }),
		});
		ok(response.ok, `PUT /Item/${id}: ${response.status}`);
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: CONFIG, env: {} });
		client = createApiClient(ctx.harper);
		const httpURL = ctx.harper.httpURL;
		mqttURL = `${httpURL.replace(/^https?/, httpURL.startsWith('https') ? 'wss' : 'ws')}/mqtt`;
		await waitForRouteReady(client, '/Item/', 120_000);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	for (const [protocolVersion, qos] of [
		[5, 1],
		[5, 2],
		[4, 1],
	] as const) {
		test(`a durable subscriber replays records with object and number data, and keeps receiving (v${protocolVersion === 5 ? 5 : '3.1.1'}, QoS ${qos})`, async () => {
			const clientId = `shape-${protocolVersion}-${qos}-${randomUUID().slice(0, 6)}`;
			const suffix = randomUUID().slice(0, 6);
			const live: Delivery[] = [];
			const first = await connect(clientId, protocolVersion, (delivery) => live.push(delivery));
			await end(first.mqttClient);
			const subscriber = await connect(clientId, protocolVersion, (delivery) => live.push(delivery));
			await subscribe(subscriber.mqttClient, 'Item/#', qos);
			await putItem(`seed-${suffix}`, 'seed');
			ok(await waitFor(() => live.length > 0), 'the live message arrives');
			await sleep(500); // the acknowledged position is saved
			await end(subscriber.mqttClient);

			await putItem(`object-${suffix}`, { a: 1 });
			await putItem(`number-${suffix}`, 5);
			await putItem(`text-${suffix}`, 'plain');

			const replayed: Delivery[] = [];
			const resumed = await connect(clientId, protocolVersion, (delivery) => replayed.push(delivery));
			try {
				strictEqual(resumed.sessionPresent, true, 'the session was kept');
				ok(
					await waitFor(() => replayed.some((delivery) => delivery.topic === `Item/text-${suffix}`)),
					`the records written while away arrive: ${replayed.map((d) => d.topic)}`
				);
				strictEqual(resumed.closed(), false, 'a delivery did not abort the connection');
				const byTopic = new Map(replayed.map(({ topic, payload }) => [topic, payload]));
				const object = JSON.parse(byTopic.get(`Item/object-${suffix}`)!.toString());
				deepStrictEqual(
					{ contentType: object.contentType, data: object.data },
					{ contentType: CONTENT_TYPE, data: { a: 1 } }
				);
				strictEqual(JSON.parse(byTopic.get(`Item/number-${suffix}`)!.toString()).data, 5);
				strictEqual(byTopic.get(`Item/text-${suffix}`)!.toString(), 'plain', 'a real text envelope is still its data');
				await sleep(300); // the acknowledgements are saved
			} finally {
				await end(resumed.mqttClient);
			}

			const again: Delivery[] = [];
			const reconnected = await connect(clientId, protocolVersion, (delivery) => again.push(delivery));
			try {
				strictEqual(reconnected.sessionPresent, true);
				await putItem(`after-${suffix}`, { b: 2 });
				ok(
					await waitFor(() => again.some((delivery) => delivery.topic === `Item/after-${suffix}`)),
					`a later record arrives after the reconnect: ${again.map((d) => d.topic)}`
				);
				strictEqual(reconnected.closed(), false);
			} finally {
				await end(reconnected.mqttClient);
			}
		});
	}

	test('REST answers an envelope with its own content type, and any other record as a record', async () => {
		const suffix = randomUUID().slice(0, 6);
		await putItem(`object-${suffix}`, { a: 1 });
		await putItem(`number-${suffix}`, 5);
		await putItem(`text-${suffix}`, 'plain');
		const get = (path: string) =>
			fetch(`${ctx.harper.httpURL}${path}`, { headers: { ...client.headers, Accept: 'application/json' } });

		const text = await get(`/Item/text-${suffix}`);
		strictEqual(text.headers.get('content-type'), CONTENT_TYPE);
		strictEqual(await text.text(), 'plain');
		for (const [id, data] of [
			[`object-${suffix}`, { a: 1 }],
			[`number-${suffix}`, 5],
		] as const) {
			const response = await get(`/Item/${id}`);
			strictEqual(response.status, 200);
			ok(response.headers.get('content-type')?.startsWith('application/json'), response.headers.get('content-type')!);
			const record = await response.json();
			deepStrictEqual({ contentType: record.contentType, data: record.data }, { contentType: CONTENT_TYPE, data });
		}
	});

	test('REST still serves a record whose data is a Blob as that blob under its contentType', async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
		const put = await fetch(`${ctx.harper.httpURL}/Asset/blob`, {
			method: 'PUT',
			headers: { ...client.headers, 'Content-Type': 'application/cbor' },
			body: cborEncode({ id: 'blob', contentType: 'image/png', data: bytes }),
		});
		ok(put.ok, `PUT /Asset/blob: ${put.status}`);
		const response = await fetch(`${ctx.harper.httpURL}/Asset/blob`, { headers: client.headers });
		strictEqual(response.headers.get('content-type'), 'image/png');
		deepStrictEqual(Buffer.from(await response.arrayBuffer()), bytes);
	});
});
