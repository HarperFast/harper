/**
 * harper#1874: a non-super user's MQTT last will is published when its connection drops, authorized
 * against the will topic only. The will row in system.hdb_session_will is the session's own
 * bookkeeping, so it is deleted whether or not the will was allowed to publish.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/mqtt/will-authorization.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, deepStrictEqual } from 'node:assert';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
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

const FIXTURE_PATH = resolve(import.meta.dirname, 'will-authorization');
const CONFIG = { threads: { count: 1 }, mqtt: { requireAuthentication: false } };
// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun, the same skip the sibling suites carry
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

type Credentials = { username?: string; password?: string };

suite('MQTT last will authorization (harper#1874)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let mqttURL = '';
	const admin: Credentials = {};
	const publisher: Credentials = { username: `will-publisher-${randomUUID().slice(0, 6)}`, password: randomUUID() };
	const reader: Credentials = { username: `will-reader-${randomUUID().slice(0, 6)}`, password: randomUUID() };

	function connect(credentials: Credentials, overrides: Partial<IClientOptions>) {
		return new Promise<MqttClient>((resolvePromise, reject) => {
			const mqttClient = mqtt.connect(mqttURL, {
				protocolVersion: 5,
				reconnectPeriod: 0,
				connectTimeout: 8_000,
				clean: true,
				...credentials,
				...overrides,
			});
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

	function end(mqttClient: MqttClient) {
		return new Promise<void>((resolvePromise) => {
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

	const willFor = (id: string, value: number) => ({
		topic: `WillTopic/${id}`,
		payload: Buffer.from(JSON.stringify({ value })),
		qos: 1 as const,
		retain: false,
	});

	/** Values a separate (super user) subscriber receives on the will's topic. */
	async function watch(id: string) {
		const received: number[] = [];
		const subscriber = await connect(admin, { clientId: `watch-${id}` });
		subscriber.on('message', (_topic, payload) => received.push(JSON.parse(payload.toString()).value));
		await new Promise<void>((resolvePromise, reject) =>
			subscriber.subscribe(`WillTopic/${id}`, { qos: 1 }, (error) => (error ? reject(error) : resolvePromise()))
		);
		return { received, subscriber };
	}

	async function willRows(clientId: string) {
		const rows = await sendOperation(ctx.harper, {
			operation: 'search_by_value',
			database: 'system',
			table: 'hdb_session_will',
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['id'],
		});
		return rows.filter((row: { id: unknown }) => Array.isArray(row.id) && row.id[0] === clientId);
	}

	function serverLog() {
		const path = ctx.harper.logDir
			? join(ctx.harper.logDir, 'hdb.log')
			: join(ctx.harper.dataRootDir, 'log', 'hdb.log');
		try {
			return readFileSync(path, 'utf8');
		} catch {
			return '';
		}
	}
	const willErrorLogged = (clientId: string) => serverLog().includes(`Error publishing MQTT will for ${clientId}`);

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: CONFIG, env: {} });
		admin.username = ctx.harper.admin.username;
		admin.password = ctx.harper.admin.password;
		const httpURL = ctx.harper.httpURL;
		mqttURL = `${httpURL.replace(/^https?/, httpURL.startsWith('https') ? 'wss' : 'ws')}/mqtt`;
		await waitForRouteReady(createApiClient(ctx.harper), '/WillTopic/', 120_000);
		for (const [user, canPublish] of [
			[publisher, true],
			[reader, false],
		] as const) {
			const role = `${user.username}-role`;
			await sendOperation(ctx.harper, {
				operation: 'add_role',
				role,
				permission: {
					super_user: false,
					data: {
						tables: {
							WillTopic: {
								read: true,
								insert: canPublish,
								update: canPublish,
								delete: false,
								attribute_permissions: [],
							},
						},
					},
				},
			});
			await sendOperation(ctx.harper, { operation: 'add_user', role, ...user, active: true });
		}
		// worker 0 publishes every stored will once, 2s after its components load; past that it can no
		// longer stand in for the disconnect path these tests exercise
		await sleep(2_500);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('a will its non-super user may publish reaches a subscriber when the connection drops', async () => {
		const id = `published-${randomUUID().slice(0, 6)}`;
		const { received, subscriber } = await watch(id);
		try {
			const client = await connect(publisher, { clientId: id, will: willFor(id, 1) });
			ok((await willRows(id)).length === 1, 'the will is stored once the CONNECT is accepted');
			client.stream.destroy();
			ok(await waitFor(() => received.length > 0), 'the subscriber receives the will');
			deepStrictEqual(received, [1]);
			ok(await waitFor(async () => (await willRows(id)).length === 0), 'the will row is deleted');
		} finally {
			await end(subscriber);
		}
	});

	test('a will its user may not publish is dropped, and its row is still deleted', async () => {
		const id = `denied-${randomUUID().slice(0, 6)}`;
		const { received, subscriber } = await watch(id);
		try {
			const client = await connect(reader, { clientId: id, will: willFor(id, 2) });
			ok((await willRows(id)).length === 1, 'the will is stored once the CONNECT is accepted');
			client.stream.destroy();
			ok(await waitFor(async () => (await willRows(id)).length === 0), 'the will row is deleted');
			ok(await waitFor(() => willErrorLogged(id)), 'the refused publish is logged');
			await sleep(500);
			deepStrictEqual(received, [], 'the will is not published');
		} finally {
			await end(subscriber);
		}
	});

	test('an anonymous client with no will touches no will row when its connection drops', async () => {
		const id = `anonymous-${randomUUID().slice(0, 6)}`;
		const anonymous = await connect({}, { clientId: id });
		anonymous.stream.destroy();
		// a later refused will on the same thread, so the log is read past where this client's would be
		const anchor = `anchor-${randomUUID().slice(0, 6)}`;
		const anchorClient = await connect(reader, { clientId: anchor, will: willFor(anchor, 3) });
		anchorClient.stream.destroy();
		ok(await waitFor(() => willErrorLogged(anchor)), 'the anchoring will error is logged');
		ok(!willErrorLogged(id), 'no will error is logged for the anonymous client');
		deepStrictEqual(await willRows(id), []);
	});

	test('a clean DISCONNECT suppresses the will and deletes its row', async () => {
		const id = `clean-${randomUUID().slice(0, 6)}`;
		const { received, subscriber } = await watch(id);
		try {
			const client = await connect(publisher, { clientId: id, will: willFor(id, 4) });
			ok((await willRows(id)).length === 1, 'the will is stored once the CONNECT is accepted');
			await end(client);
			ok(await waitFor(async () => (await willRows(id)).length === 0), 'the will row is deleted');
			// a publish would be issued before the delete, so once the row is gone only delivery could lag
			await sleep(500);
			deepStrictEqual(received, [], 'the will is not published');
		} finally {
			await end(subscriber);
		}
	});
});
