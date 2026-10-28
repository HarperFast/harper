/**
 * A durable session saves at every acknowledgement, so a client that acknowledges a steady stream keeps the session
 * saving when a save takes longer than the gap between acknowledgements. Its SUBSCRIBE and UNSUBSCRIBE must be
 * answered by the first save that holds the change, not by the stream pausing. The saved subscription list is read at
 * the moment of the reply, so a reply sent before its save would show. The fixture adds the save latency: unslowed, a
 * save (about 0.4 ms on RocksDB, 1.7 ms on LMDB) is shorter than the 5 ms gap and the session goes idle between acks.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/mqtt/durable-subscribe-under-load.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import {
	setupHarperWithFixture,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'durable-subscribe-under-load');
const ENGINES = ['rocksdb', 'lmdb'] as const;
const STREAM_PER_SECOND = 200;
const TICK_MS = 2;
// longer than the 5 ms between acknowledgements, so every save finds the session dirtied again
const SAVE_LATENCY_MS = 10;
const REPLY_DEADLINE_MS = 5_000;
const SUBACK_BOUND_MS = 1_000;
// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun, the same skip the sibling suites carry
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

for (const engine of ENGINES) {
	suite(
		`MQTT durable SUBSCRIBE and UNSUBSCRIBE under a steady acknowledged stream [${engine}]`,
		{ skip: skipSuite },
		(ctx: ContextWithHarper) => {
			let mqttURL = '';
			let publisher: MqttClient | undefined;
			let subscriber: MqttClient | undefined;
			let streaming: NodeJS.Timeout | undefined;
			const received: number[] = [];
			const clientId = `under-load-${randomUUID().slice(0, 6)}`;

			function options(overrides: Partial<IClientOptions>): IClientOptions {
				return {
					protocolVersion: 5,
					reconnectPeriod: 0,
					connectTimeout: 8_000,
					username: ctx.harper.admin.username,
					password: ctx.harper.admin.password,
					...overrides,
				};
			}

			function connect(overrides: Partial<IClientOptions>, onMessage?: () => void) {
				return new Promise<MqttClient>((resolvePromise, reject) => {
					const mqttClient = mqtt.connect(mqttURL, options(overrides));
					if (onMessage) mqttClient.on('message', onMessage);
					const timer = setTimeout(() => reject(new Error(`connect timed out for ${overrides.clientId}`)), 10_000);
					mqttClient.once('connect', () => {
						clearTimeout(timer);
						mqttClient.on('error', () => {});
						resolvePromise(mqttClient);
					});
					mqttClient.once('error', (error) => {
						clearTimeout(timer);
						mqttClient.end(true);
						reject(error);
					});
				});
			}

			function end(mqttClient: MqttClient | undefined) {
				return new Promise<void>((resolvePromise) => {
					if (!mqttClient) return resolvePromise();
					const timer = setTimeout(resolvePromise, 3_000);
					mqttClient.end(true, {}, () => {
						clearTimeout(timer);
						resolvePromise();
					});
				});
			}

			async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000) {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					if (await predicate()) return true;
					await sleep(20);
				}
				return predicate();
			}

			async function savedTopics(): Promise<string[]> {
				const [record] = await sendOperation(ctx.harper, {
					operation: 'search_by_id',
					database: 'system',
					table: 'hdb_durable_session',
					ids: [clientId],
					get_attributes: ['*'],
				});
				return (record?.subscriptions ?? []).map((entry: { topic: string }) => entry.topic).sort();
			}

			async function timed(request: (done: (error?: Error | null) => void) => void) {
				const started = performance.now();
				await new Promise<void>((resolvePromise, reject) => {
					const timer = setTimeout(
						() => reject(new Error(`no reply within ${REPLY_DEADLINE_MS} ms`)),
						REPLY_DEADLINE_MS
					);
					request((error) => {
						clearTimeout(timer);
						if (error) reject(error);
						else resolvePromise();
					});
				});
				const elapsed = performance.now() - started;
				return { elapsed, topics: await savedTopics() };
			}

			async function setSaveLatency(ms: number) {
				const response = await fetch(`${ctx.harper.httpURL}/SessionWriteLatency/`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': createApiClient(ctx.harper).headers.Authorization,
					},
					body: JSON.stringify({ ms }),
				});
				ok(response.ok, `SessionWriteLatency: ${response.status}`);
			}

			before(async () => {
				await setupHarperWithFixture(ctx, FIXTURE_PATH, {
					// the latency set over HTTP must reach the thread that saves the MQTT session
					config: { threads: { count: 1 } },
					env: { HARPER_STORAGE_ENGINE: engine },
				});
				const client = createApiClient(ctx.harper);
				const httpURL = ctx.harper.httpURL;
				mqttURL = `${httpURL.replace(/^https?/, httpURL.startsWith('https') ? 'wss' : 'ws')}/mqtt`;
				await waitForRouteReady(client, '/Stream/', 120_000);
			});

			after(async () => {
				clearInterval(streaming);
				await end(publisher);
				await end(subscriber);
				await teardownHarper(ctx);
			});

			test('the requested storage engine is the one in effect', async () => {
				const response = await fetch(`${ctx.harper.httpURL}/StorageEngineInfo/`, {
					headers: { Authorization: createApiClient(ctx.harper).headers.Authorization },
				});
				strictEqual((await response.json()).engine, engine);
			});

			test('SUBSCRIBE and UNSUBSCRIBE are answered by their own save while the stream keeps acknowledging', async (t) => {
				subscriber = await connect({ clientId, clean: false }, () => received.push(performance.now()));
				await new Promise<void>((resolvePromise, reject) =>
					subscriber!.subscribe('Stream/#', { qos: 1, rh: 2 }, (error) => (error ? reject(error) : resolvePromise()))
				);
				await setSaveLatency(SAVE_LATENCY_MS);
				t.after(() => setSaveLatency(0));
				publisher = await connect({ clientId: `publisher-${randomUUID().slice(0, 6)}`, clean: true });
				let next = 0;
				const startedAt = performance.now();
				streaming = setInterval(() => {
					const owed = Math.floor(((performance.now() - startedAt) * STREAM_PER_SECOND) / 1000);
					while (next < owed) publisher!.publish(`Stream/m${next++}`, JSON.stringify({ value: next }), { qos: 0 });
				}, TICK_MS);
				ok(
					await waitFor(() => received.length >= STREAM_PER_SECOND),
					`the stream is flowing: ${received.length} received`
				);

				const streamStart = received.length;
				const windowStart = performance.now();
				const subscribed = await timed((done) =>
					subscriber!.subscribe('Other/#', { qos: 1, rh: 2 }, (error, granted) =>
						done(error ?? (granted?.[0]?.qos === 1 ? null : new Error(`refused: ${JSON.stringify(granted)}`)))
					)
				);
				deepStrictEqual(
					subscribed.topics,
					['Other/#', 'Stream/#'],
					'the SUBACK follows the save that holds the subscription'
				);
				ok(subscribed.elapsed < SUBACK_BOUND_MS, `SUBACK took ${Math.round(subscribed.elapsed)} ms`);

				const unsubscribed = await timed((done) => subscriber!.unsubscribe('Other/#', {}, (error) => done(error)));
				deepStrictEqual(unsubscribed.topics, ['Stream/#'], 'the UNSUBACK follows the save that holds the removal');
				ok(unsubscribed.elapsed < SUBACK_BOUND_MS, `UNSUBACK took ${Math.round(unsubscribed.elapsed)} ms`);

				// the load was real throughout: the replies did not come from a pause in the stream
				const rate = ((received.length - streamStart) * 1000) / (performance.now() - windowStart);
				t.diagnostic(
					`${Math.round(rate)} msg/s; SUBACK ${Math.round(subscribed.elapsed)} ms, UNSUBACK ${Math.round(unsubscribed.elapsed)} ms`
				);
				ok(rate >= STREAM_PER_SECOND / 2, `the stream delivered ${Math.round(rate)} msg/s while both requests ran`);
			});
		}
	);
}
