/**
 * harper#3034 / harper#4427: the startup will replay publishes a will left by a crashed process only while its
 * client has not reconnected, and never touches the will of a connection the restarted process holds.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/mqtt/will-replay-after-restart.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, deepStrictEqual } from 'node:assert';
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

const FIXTURE_PATH = resolve(import.meta.dirname, 'will-authorization');
const CONFIG = { threads: { count: 2 }, mqtt: { requireAuthentication: false } };
// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun, the same skip the sibling suites carry
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';
// worker 0 replays stored wills 2 s after its components load
const REPLAY_DELAY_MS = 2_000;

suite('MQTT will replay after a crash (harper#3034, harper#4427)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let mqttURL = '';
	const suffix = randomUUID().slice(0, 6);
	// the replay walks rows in client id order: the client that stays away sorts first, so its will marks
	// the point the replay reached
	const goneId = `a-gone-${suffix}`;
	const backId = `b-back-${suffix}`;

	function connect(
		overrides: Partial<IClientOptions>,
		onMessage?: (topic: string, value: number, dup: boolean) => void
	) {
		return new Promise<MqttClient>((resolvePromise, reject) => {
			const mqttClient = mqtt.connect(mqttURL, {
				protocolVersion: 5,
				reconnectPeriod: 0,
				connectTimeout: 8_000,
				clean: true,
				...overrides,
			});
			if (onMessage)
				mqttClient.on('message', (topic, payload, packet) =>
					onMessage(topic, JSON.parse(payload.toString()).value, packet.dup)
				);
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

	const willFor = (id: string, value: number) => ({
		topic: `WillTopic/${id}`,
		payload: Buffer.from(JSON.stringify({ value })),
		qos: 1 as const,
		retain: false,
	});

	function publish(mqttClient: MqttClient, id: string, value: number) {
		return new Promise<void>((resolvePromise, reject) =>
			mqttClient.publish(`WillTopic/${id}`, JSON.stringify({ value }), { qos: 1 }, (error) =>
				error ? reject(error) : resolvePromise()
			)
		);
	}

	async function willRows(clientId: string): Promise<unknown[][]> {
		const rows = await sendOperation(ctx.harper, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_session_will',
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id'],
		});
		return rows.map((row: { id: unknown }) => row.id).filter((id: unknown) => Array.isArray(id) && id[0] === clientId);
	}

	async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await predicate()) return true;
			await sleep(50);
		}
		return predicate();
	}

	function useURL() {
		const httpURL = ctx.harper.httpURL;
		mqttURL = `${httpURL.replace(/^https?/, httpURL.startsWith('https') ? 'wss' : 'ws')}/mqtt`;
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: CONFIG, env: {} });
		useURL();
		await waitForRouteReady(createApiClient(ctx.harper), '/WillTopic/', 120_000);
		// past this boot's own replay, which would otherwise publish the wills stored below
		await sleep(REPLAY_DELAY_MS + 500);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a reconnected client keeps its new will, and only a client that stays away gets its old one', async () => {
		// [topic id, value] in arrival order; the subscriber's durable session also delivers what was published
		// while it was disconnected
		const received: [string, number][] = [];
		const onMessage = (topic: string, value: number, dup: boolean) => {
			if (!dup) received.push([topic.slice('WillTopic/'.length), value]);
		};
		const watcherId = `watch-${suffix}`;
		const watcherOptions = { clientId: watcherId, clean: false };
		const watcher = await connect(watcherOptions, onMessage);
		for (const id of [goneId, backId])
			await new Promise<void>((resolvePromise, reject) =>
				watcher.subscribe(`WillTopic/${id}`, { qos: 1 }, (error) => (error ? reject(error) : resolvePromise()))
			);

		await connect({ clientId: goneId, will: willFor(goneId, 1) });
		const before = await connect({ clientId: backId, will: willFor(backId, 2) });
		await publish(before, backId, 20);
		ok(await waitFor(() => received.some(([id, value]) => id === backId && value === 20)), 'the first online arrives');
		deepStrictEqual((await willRows(goneId)).length, 1);
		deepStrictEqual((await willRows(backId)).length, 1);

		// a crash: no connection closes, so every will row is left for the next boot
		const { dataRootDir, hostname, process: harperProcess } = ctx.harper;
		harperProcess.kill('SIGKILL');
		await killHarper(ctx, { graceMs: 0 });
		(ctx as any).harper = { dataRootDir, hostname };
		await startHarper(ctx as any, { config: CONFIG, env: {} });
		useURL();

		await connect(watcherOptions, onMessage);
		const after = await connect({ clientId: backId, will: willFor(backId, 3) });
		await publish(after, backId, 30);

		ok(
			await waitFor(() => received.some(([id, value]) => id === goneId && value === 1)),
			'the will of the client that stayed away is published'
		);
		const reconnectedFirst =
			received.findIndex(([id, value]) => id === backId && value === 30) <
			received.findIndex(([id, value]) => id === goneId && value === 1);
		ok(reconnectedFirst, 'precondition: the client reconnected before the replay reached it');
		ok(await waitFor(async () => (await willRows(goneId)).length === 0), 'the stayed-away client’s row is deleted');
		// both old rows were read by the time the replay published the first one; give the second a moment
		await sleep(500);
		const backRows = await willRows(backId);
		deepStrictEqual(backRows.length, 1, 'only the reconnected client’s new will row remains');
		deepStrictEqual(
			received.filter(([id, value]) => id === backId && (value === 2 || value === 3)),
			[],
			'no will of the reconnected client is published while it is connected'
		);

		after.stream.destroy();
		ok(
			await waitFor(() => received.some(([id, value]) => id === backId && value === 3)),
			'the new connection’s will is published when it drops'
		);
		ok(await waitFor(async () => (await willRows(backId)).length === 0), 'its row is deleted');
		await sleep(500);
		deepStrictEqual(
			received.filter(([, value]) => value < 10),
			[
				[goneId, 1],
				[backId, 3],
			],
			'each published will arrives exactly once'
		);
	});
});
