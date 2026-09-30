/**
 * harper#2448: a durable MQTT session resumes through Table.subscribe's checked replay. A session whose
 * position the history no longer covers is reported as not present, instead of replaying short.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/mqtt/durable-resume.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import {
	setupHarperWithFixture,
	startHarper,
	killHarper,
	teardownHarper,
	sendOperation,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'durable-resume');
// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun, the same skip the sibling suites carry
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

suite(
	'MQTT durable sessions resume through the checked subscription (harper#2448)',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let mqttURL = '';

		function options(overrides: Partial<IClientOptions>): IClientOptions {
			return {
				protocolVersion: 5,
				reconnectPeriod: 0,
				connectTimeout: 8_000,
				clean: false,
				username: ctx.harper.admin.username,
				password: ctx.harper.admin.password,
				...overrides,
			};
		}

		/** Attaches `onMessage` before CONNACK: a resumed session replays the moment it is accepted. */
		function connect(overrides: Partial<IClientOptions>, onMessage?: (topic: string, payload: Buffer) => void) {
			return new Promise<{ mqttClient: MqttClient; sessionPresent: boolean }>((resolvePromise, reject) => {
				const mqttClient = mqtt.connect(mqttURL, options(overrides));
				if (onMessage) mqttClient.on('message', onMessage);
				const timer = setTimeout(() => reject(new Error(`connect timed out for ${overrides.clientId}`)), 10_000);
				mqttClient.once('connect', (connack) => {
					clearTimeout(timer);
					mqttClient.on('error', () => {});
					resolvePromise({ mqttClient, sessionPresent: connack.sessionPresent });
				});
				mqttClient.once('error', (error) => {
					clearTimeout(timer);
					mqttClient.end(true);
					reject(error);
				});
			});
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

		async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (await predicate()) return true;
				await sleep(30);
			}
			return predicate();
		}

		async function storedSession(clientId: string) {
			const records = await sendOperation(ctx.harper, {
				operation: 'search_by_id',
				database: 'system',
				table: 'hdb_durable_session',
				ids: [clientId],
				get_attributes: ['*'],
			});
			return records[0];
		}

		async function put(table: string, id: string, value: number) {
			const response = await fetch(`${ctx.harper.httpURL}/${table}/${id}`, {
				method: 'PUT',
				headers: { ...client.headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, value }),
			});
			ok(response.ok, `PUT /${table}/${id}: ${response.status}`);
		}

		/** The saved entry once the server's save at disconnect has landed. */
		async function settledEntry(clientId: string) {
			let previous;
			let entry = (await storedSession(clientId)).subscriptions[0];
			do {
				previous = entry;
				await sleep(200);
				entry = (await storedSession(clientId)).subscriptions[0];
			} while (entry.startTime !== previous.startTime);
			return entry;
		}

		/** Prunes through the operations API, which runs the prune as a job, and waits for the job to finish. */
		async function pruneBefore(timestamp: number) {
			const started = await sendOperation(ctx.harper, {
				operation: 'delete_transaction_logs_before',
				database: 'data',
				timestamp,
			});
			const jobId = started.job_id ?? started.message?.match(/id ([\w-]+)/)?.[1];
			ok(jobId, `a prune job was started: ${JSON.stringify(started)}`);
			let job;
			ok(
				await waitFor(async () => {
					[job] = await sendOperation(ctx.harper, { operation: 'get_job', id: jobId });
					return job?.status === 'COMPLETE' || job?.status === 'ERROR';
				}, 30_000),
				`the prune job finished: ${JSON.stringify(job)}`
			);
			strictEqual(job.status, 'COMPLETE', JSON.stringify(job));
		}

		/** Subscribes durably, lets one write through and acknowledges it, and returns the saved entry. */
		async function establish(clientId: string, topic: string, qos: 1 | 2, protocolVersion: 4 | 5, table = 'Readings') {
			const received: number[] = [];
			const { mqttClient } = await connect({ clientId, clean: true, protocolVersion });
			await end(mqttClient);
			const { mqttClient: subscriber } = await connect({ clientId, protocolVersion }, (_topic, payload) =>
				received.push(JSON.parse(payload.toString()).value)
			);
			await subscribe(subscriber, topic, qos);
			await put(table, topic.split('/')[1] === '#' ? `r-${randomUUID().slice(0, 6)}` : topic.split('/')[1], 1);
			ok(await waitFor(() => received.includes(1)), 'the live message arrives');
			let entry;
			ok(
				await waitFor(async () => {
					entry = (await storedSession(clientId))?.subscriptions?.[0];
					return entry?.databaseGeneration !== undefined;
				}),
				'the acknowledged position is saved and bound to the database generation'
			);
			await end(subscriber);
			return entry;
		}

		async function useHarper() {
			client = createApiClient(ctx.harper);
			const httpURL = ctx.harper.httpURL;
			mqttURL = `${httpURL.replace(/^https?/, httpURL.startsWith('https') ? 'wss' : 'ws')}/mqtt`;
			await waitForRouteReady(client, '/Readings/', 120_000);
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
			await useHarper();
			await put('Readings', 'seed', 0);
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		for (const [protocolVersion, qos] of [
			[5, 1],
			[5, 2],
			[4, 1],
		] as const) {
			test(`a reconnect resumes and receives what it missed (v${protocolVersion === 5 ? 5 : '3.1.1'}, QoS ${qos})`, async () => {
				const clientId = `control-${protocolVersion}-${qos}-${randomUUID().slice(0, 6)}`;
				await establish(clientId, 'Readings/#', qos, protocolVersion);
				const id = `missed-${randomUUID().slice(0, 6)}`;
				await put('Readings', id, 2);
				const received: number[] = [];
				const { mqttClient, sessionPresent } = await connect({ clientId, protocolVersion }, (_topic, payload) =>
					received.push(JSON.parse(payload.toString()).value)
				);
				try {
					strictEqual(sessionPresent, true);
					ok(await waitFor(() => received.includes(2)), `the message published while away arrives: ${received}`);
				} finally {
					await end(mqttClient);
				}
			});
		}

		test('a wildcard session whose position fell below the floor is not present, with no short replay', async () => {
			const clientId = `pruned-${randomUUID().slice(0, 6)}`;
			await establish(clientId, 'Readings/#', 1, 5);
			// disconnecting saved the position the database had reached
			const saved = await settledEntry(clientId);
			await sleep(20);
			await put('Readings', `after-${randomUUID().slice(0, 6)}`, 3);
			// the floor passes the saved position but stays below the newer write, so nothing it needs is removed
			await pruneBefore(saved.startTime + 1);
			const received: number[] = [];
			const { mqttClient, sessionPresent } = await connect({ clientId }, (_topic, payload) =>
				received.push(JSON.parse(payload.toString()).value)
			);
			try {
				strictEqual(sessionPresent, false, 'the client is told its session is gone');
				await sleep(300);
				deepStrictEqual(received, [], 'nothing is replayed from the discarded position');
			} finally {
				await end(mqttClient);
			}
		});

		test('a record topic keeps its session across a floor raise while its history is intact', async () => {
			const id = `record-${randomUUID().slice(0, 6)}`;
			const clientId = `record-${randomUUID().slice(0, 6)}`;
			await put('Readings', id, 0);
			await establish(clientId, `Readings/${id}`, 1, 5);
			const saved = await settledEntry(clientId);
			await sleep(20);
			await put('Readings', id, 4);
			await pruneBefore(saved.startTime + 1);
			const received: number[] = [];
			const { mqttClient, sessionPresent } = await connect({ clientId }, (_topic, payload) =>
				received.push(JSON.parse(payload.toString()).value)
			);
			try {
				strictEqual(sessionPresent, true, "the record's own versions prove nothing was lost");
				ok(await waitFor(() => received.includes(4)), `the update made while away arrives: ${received}`);
			} finally {
				await end(mqttClient);
			}
		});

		test('a quiet topic keeps its session while other tables advance the log', async () => {
			const clientId = `quiet-${randomUUID().slice(0, 6)}`;
			const entry = await establish(clientId, 'Readings/#', 1, 5);
			const { mqttClient, sessionPresent } = await connect({ clientId });
			strictEqual(sessionPresent, true);
			for (let i = 0; i < 3; i++) await put('Noise', `n${i}`, i);
			await end(mqttClient);
			const moved = await settledEntry(clientId);
			ok(moved.startTime > entry.startTime, 'disconnecting saves the position the database reached');
			await sleep(20);
			await put('Noise', 'late', 9);
			await pruneBefore(moved.startTime);
			const again = await connect({ clientId });
			try {
				strictEqual(again.sessionPresent, true, 'a floor at the saved position still resumes');
			} finally {
				await end(again.mqttClient);
			}
		});

		test(
			'a session resumes across a hard kill and replays the delivery it never acknowledged',
			{ timeout: 180_000 },
			async () => {
				const clientId = `restart-${randomUUID().slice(0, 6)}`;
				const { mqttClient: fresh } = await connect({ clientId, clean: true });
				await end(fresh);
				const delivered: number[] = [];
				const { mqttClient: subscriber } = await connect({
					clientId,
					customHandleAcks: (_topic, payload, _packet, done) => {
						const { value } = JSON.parse(payload.toString());
						delivered.push(value);
						if (value !== 3) done(0);
					},
				});
				await subscribe(subscriber, 'Readings/#', 1);
				await put('Readings', `acked-${randomUUID().slice(0, 6)}`, 1);
				ok(await waitFor(() => delivered.includes(1)), 'the acknowledged message arrives');
				await put('Readings', `unacked-${randomUUID().slice(0, 6)}`, 3);
				ok(await waitFor(() => delivered.includes(3)), 'the message left unacknowledged arrives');
				// SIGKILL: no disconnect save, so the session resumes from what its checkpoints wrote
				await killHarper(ctx, { graceMs: 0 });
				subscriber.end(true);
				await startHarper(ctx, { config: {}, env: {} });
				await useHarper();
				await put('Readings', `away-${randomUUID().slice(0, 6)}`, 4);
				const received: number[] = [];
				const { mqttClient, sessionPresent } = await connect({ clientId }, (_topic, payload) =>
					received.push(JSON.parse(payload.toString()).value)
				);
				try {
					strictEqual(sessionPresent, true, 'the saved session and its generation survive the restart');
					ok(
						await waitFor(() => received.includes(3) && received.includes(4)),
						`the unacknowledged message and the one written after the restart arrive: ${received}`
					);
				} finally {
					await end(mqttClient);
				}
			}
		);
	}
);
