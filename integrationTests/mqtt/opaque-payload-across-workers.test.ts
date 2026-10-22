/**
 * A PUBLISH whose payload is not a JSON object is stored as `{ contentType, data }` and delivered
 * as those bytes verbatim. A subscriber on another worker thread receives the record decoded from
 * the transaction log, where `data` is a plain Uint8Array rather than a Buffer; mqtt-packet cannot
 * encode that, and the subscriber used to stop receiving everything while its socket stayed open.
 *
 * Subscribers are spread across workers over both TCP and WebSocket, and each learns its own worker
 * from the WorkerProbe resource, so the cross-worker path is asserted to be exercised, not assumed.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/mqtt/opaque-payload-across-workers.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'opaque-payload-across-workers');

// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun — the same skip the sibling MQTT
// suites carry.
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const THREADS = 4;
const SUBSCRIBERS_PER_TRANSPORT = 6;
const TOPIC = 'Feed/stream';
// The kernel spreads connections across workers only where every worker binds the port (reusePort).
const spreadAcrossWorkers = process.platform === 'linux';

interface Subscriber {
	transport: 'tcp' | 'ws';
	client: MqttClient;
	threadId: number;
	payloads: string[];
}

suite('MQTT opaque payloads delivered across worker threads', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let wsURL = '';
	let tcpURL = '';

	function connect(url: string, opts: IClientOptions = {}): Promise<MqttClient> {
		return new Promise((resolvePromise, reject) => {
			const client = mqtt.connect(url, {
				protocolVersion: 5,
				reconnectPeriod: 0,
				connectTimeout: 8_000,
				clean: true,
				username: ctx.harper.admin.username,
				password: ctx.harper.admin.password,
				...opts,
			});
			const onError = (error: Error) => {
				client.end(true);
				reject(error);
			};
			client.once('error', onError);
			client.once('connect', () => {
				client.removeListener('error', onError);
				client.on('error', () => {});
				resolvePromise(client);
			});
		});
	}

	function subscribe(client: MqttClient, topic: string): Promise<void> {
		return new Promise((resolvePromise, reject) =>
			client.subscribe(topic, { qos: 0 }, (error) => (error ? reject(error) : resolvePromise()))
		);
	}

	function publish(client: MqttClient, payload: string): Promise<void> {
		return new Promise((resolvePromise, reject) =>
			client.publish(TOPIC, payload, { qos: 1, retain: false }, (error) => (error ? reject(error) : resolvePromise()))
		);
	}

	function endQuiet(client: MqttClient | undefined): Promise<void> {
		return new Promise((resolvePromise) => {
			if (!client) return resolvePromise();
			const timer = setTimeout(resolvePromise, 3_000);
			client.end(true, {}, () => {
				clearTimeout(timer);
				resolvePromise();
			});
		});
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await sleep(30);
		}
		return predicate();
	}

	/** Connects, then reads which worker serves the connection off the WorkerProbe subscription. */
	async function workerOf(client: MqttClient): Promise<number> {
		let threadId: number | undefined;
		const onMessage = (topic: string, payload: Buffer) => {
			if (topic.startsWith('WorkerProbe/')) threadId = JSON.parse(payload.toString()).threadId;
		};
		client.on('message', onMessage);
		try {
			await subscribe(client, 'WorkerProbe/#');
			ok(await waitFor(() => threadId !== undefined), 'WorkerProbe never reported a worker thread');
			return threadId;
		} finally {
			client.removeListener('message', onMessage);
		}
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: { threads: { count: THREADS } }, env: {} });
		const httpURL = ctx.harper.httpURL;
		wsURL = `${httpURL.replace(/^http/, 'ws')}/mqtt`;
		tcpURL = `mqtt://${ctx.harper.hostname}:1883`;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('text, JSON array, JSON string, declared opaque type and JSON object reach every subscriber on every worker', async () => {
		const clients: MqttClient[] = [];
		const subscribers: Subscriber[] = [];
		try {
			// No content type on the publishing connection: anything that does not start with `{` is
			// stored as opaque application/octet-stream bytes. A declared type with no registered
			// deserializer is stored the same way, under its own name.
			const tcpPublisher = await connect(tcpURL);
			clients.push(tcpPublisher);
			const typedPublisher = await connect(wsURL, {
				wsOptions: { headers: { 'content-type': 'application/x-opaque' } },
			});
			clients.push(typedPublisher);
			const publisherThreads = [await workerOf(tcpPublisher), await workerOf(typedPublisher)];

			for (const transport of ['tcp', 'ws'] as const) {
				for (let i = 0; i < SUBSCRIBERS_PER_TRANSPORT; i++) {
					const client = await connect(transport === 'tcp' ? tcpURL : wsURL);
					clients.push(client);
					const subscriber: Subscriber = { transport, client, threadId: await workerOf(client), payloads: [] };
					client.on('message', (topic, payload) => {
						if (topic === TOPIC) subscriber.payloads.push(payload.toString());
					});
					await subscribe(client, TOPIC);
					subscribers.push(subscriber);
				}
			}

			const layout = subscribers.map((s) => `${s.transport}@${s.threadId}`).join(' ');
			if (spreadAcrossWorkers) {
				for (const transport of ['tcp', 'ws'] as const) {
					const threads = new Set(subscribers.filter((s) => s.transport === transport).map((s) => s.threadId));
					ok(threads.size >= 2, `${transport} subscribers all landed on one worker: ${layout}`);
				}
				for (const publisherThread of publisherThreads)
					ok(
						subscribers.some((s) => s.threadId !== publisherThread),
						`no subscriber is on a different worker from the publisher on ${publisherThread}: ${layout}`
					);
			}

			const expected = ['plain text', '[1,2,3]', '"a JSON string"', 'declared opaque type', '{"n":4}'];
			await publish(tcpPublisher, expected[0]);
			await publish(tcpPublisher, expected[1]);
			await publish(tcpPublisher, expected[2]);
			await publish(typedPublisher, expected[3]);
			await publish(tcpPublisher, expected[4]);

			const complete = await waitFor(() => subscribers.every((s) => s.payloads.length >= expected.length));
			for (const subscriber of subscribers)
				deepStrictEqual(
					subscriber.payloads.map((payload) => (payload.startsWith('{') ? JSON.parse(payload) : payload)),
					[...expected.slice(0, 4), { n: 4 }],
					`${subscriber.transport} subscriber on worker ${subscriber.threadId} (publishers on ${publisherThreads}) ` +
						`did not receive every message${complete ? '' : ' before the timeout'}; layout: ${layout}`
				);
		} finally {
			for (const client of clients) await endQuiet(client);
		}
	});

	test('a delivery that cannot be encoded closes the connection, and the client can reconnect', async () => {
		for (const url of [tcpURL, wsURL]) {
			const client = await connect(url);
			try {
				let closed = false;
				client.on('close', () => (closed = true));
				// the failing delivery can abort the connection before the SUBACK is written
				client.subscribe('Unserializable/#', { qos: 0 }, () => {});
				ok(await waitFor(() => closed), `${url}: the connection stayed open after its delivery failed`);
			} finally {
				await endQuiet(client);
			}
			const reconnected = await connect(url);
			try {
				ok((await workerOf(reconnected)) > 0, `${url}: a reconnected client must be served again`);
			} finally {
				await endQuiet(reconnected);
			}
		}
	});
});
