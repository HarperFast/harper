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
const MIN_SUBSCRIBERS_PER_TRANSPORT = 4;
// the kernel picks a worker by hashing the connection, so a few more may be needed to reach a second one
const MAX_SUBSCRIBERS_PER_TRANSPORT = 16;
const TOPIC = 'Feed/stream';
const OPERATION_TIMEOUT_MS = 10_000;
// Only where every worker binds the port (reusePort) does the kernel spread connections across them.
const spreadAcrossWorkers = process.platform === 'linux';

interface Subscriber {
	transport: 'tcp' | 'ws';
	client: MqttClient;
	threadId: number;
	payloads: Buffer[];
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
				client.removeListener('close', onClose);
				client.end(true);
				reject(error);
			};
			const onClose = () => onError(new Error(`${url} closed before CONNACK`));
			client.once('error', onError);
			client.once('close', onClose);
			client.once('connect', () => {
				client.removeListener('error', onError);
				client.removeListener('close', onClose);
				client.on('error', () => {});
				resolvePromise(client);
			});
		});
	}

	// with reconnect off, mqtt.js leaves these callbacks pending forever once the connection drops
	function withDeadline(what: string, operation: (done: (error?: Error) => void) => void): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => reject(new Error(`${what} timed out`)), OPERATION_TIMEOUT_MS);
			operation((error) => {
				clearTimeout(timer);
				if (error) reject(error);
				else resolvePromise();
			});
		});
	}

	function subscribe(client: MqttClient, topic: string): Promise<void> {
		return withDeadline(`subscribe to ${topic}`, (done) => client.subscribe(topic, { qos: 0 }, (error) => done(error)));
	}

	function publish(client: MqttClient, payload: Buffer): Promise<void> {
		return withDeadline(`publish ${payload.toString('hex')}`, (done) =>
			client.publish(TOPIC, payload, { qos: 1, retain: false }, (error) => done(error))
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

	test('text, JSON array, JSON string, binary, declared opaque type and JSON object reach every subscriber on every worker', async (t) => {
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
				const threads = new Set<number>();
				for (let i = 0; i < MAX_SUBSCRIBERS_PER_TRANSPORT; i++) {
					if (i >= MIN_SUBSCRIBERS_PER_TRANSPORT && threads.size >= 2) break;
					const client = await connect(transport === 'tcp' ? tcpURL : wsURL);
					clients.push(client);
					const subscriber: Subscriber = { transport, client, threadId: await workerOf(client), payloads: [] };
					client.on('message', (topic, payload) => {
						if (topic === TOPIC) subscriber.payloads.push(payload);
					});
					await subscribe(client, TOPIC);
					subscribers.push(subscriber);
					threads.add(subscriber.threadId);
				}
				// with two subscriber workers, at least one subscriber is off each publisher's worker
				if (threads.size < 2) {
					const message = `${transport} subscribers all landed on worker ${[...threads]}`;
					ok(!spreadAcrossWorkers, message);
					t.diagnostic(`${message}; this platform does not spread connections, so delivery stays on one worker`);
				}
			}
			const layout = subscribers.map((s) => `${s.transport}@${s.threadId}`).join(' ');

			const opaque = [
				[tcpPublisher, 'plain text'],
				[tcpPublisher, '[1,2,3]'],
				[tcpPublisher, '"a JSON string"'],
				[tcpPublisher, Buffer.from([0xff, 0x00, 0x80, 0xfe])],
				[typedPublisher, 'declared opaque type'],
			] as const;
			const expected = [...opaque.map(([, payload]) => Buffer.from(payload).toString('hex')), { n: 4 }];
			for (const [publisher, payload] of opaque) await publish(publisher, Buffer.from(payload));
			await publish(tcpPublisher, Buffer.from('{"n":4}'));

			const complete = await waitFor(() => subscribers.every((s) => s.payloads.length >= expected.length));
			for (const subscriber of subscribers)
				deepStrictEqual(
					subscriber.payloads.map((payload) =>
						payload[0] === 0x7b ? JSON.parse(payload.toString()) : payload.toString('hex')
					),
					expected,
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
				// the abort can come before the SUBACK
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
