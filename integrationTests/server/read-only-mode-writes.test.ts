/**
 * A read-only server (`storage.readOnly`) refuses writes with HTTP 405 over REST and the operations API,
 * and with a failed acknowledgment over MQTT (harper#474). Runs on whichever engine
 * HARPER_STORAGE_ENGINE selects.
 *
 *   npm run test:integration -- "integrationTests/server/read-only-mode-writes.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';

import mqtt, { type MqttClient } from 'mqtt';
import request from 'supertest';

import {
	setupHarperWithFixture,
	killHarper,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
} from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'read-only-mode-writes');
const READ_ONLY = 'Server is in read-only mode';
const ACK_TIMEOUT_MS = 8_000;

// Read-only startup fails on Windows (#2853); mqtt.js's WebSocket transport doesn't complete CONNACK on Bun.
const skipSuite = process.platform === 'win32';
const skipMqtt = process.env.HARPER_RUNTIME === 'bun';

suite('read-only mode rejects writes', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH);
		client = createApiClient(ctx.harper);
		await request(ctx.harper.httpURL)
			.put('/Note/seed')
			.set(client.headers)
			.send({ id: 'seed', body: 'seed' })
			.expect((r: any) => ok(r.status < 300, `seeding failed: ${r.status} ${r.text}`));
		// create_table leaves the schema undeclared, so an insert can add attributes
		await client
			.req()
			.send({ operation: 'create_table', database: 'readonlytest', table: 'Dyn', primary_key: 'id' })
			.expect(200);
		await client
			.req()
			.send({ operation: 'insert', database: 'readonlytest', table: 'Dyn', records: [{ id: 1, known: 'a' }] })
			.expect(200);
		// The first MQTT connect creates the system session table, which a read-only server cannot do
		if (!skipMqtt) strictEqual(await mqttPublish('mqtt-control'), 0, 'control: MQTT publish succeeds while writable');
		await killHarper(ctx);
		await startHarper(ctx, { config: { storage: { readOnly: true } }, env: {} });
		client = createApiClient(ctx.harper);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function mqttPublish(id: string): Promise<number> {
		const httpURL = ctx.harper.httpURL;
		const mqttURL = `${httpURL.replace(/^https?/, httpURL.startsWith('https') ? 'wss' : 'ws')}/mqtt`;
		const mqttClient: MqttClient = await new Promise((resolvePromise, reject) => {
			const connection = mqtt.connect(mqttURL, {
				protocolVersion: 5,
				reconnectPeriod: 0,
				connectTimeout: ACK_TIMEOUT_MS,
				username: ctx.harper.admin.username,
				password: ctx.harper.admin.password,
			});
			connection.once('error', reject);
			connection.once('connect', () => {
				connection.on('error', () => {});
				resolvePromise(connection);
			});
		});
		try {
			return await new Promise<number>((resolvePromise, reject) => {
				const timer = setTimeout(() => reject(new Error('no PUBACK')), ACK_TIMEOUT_MS);
				mqttClient.publish(`Note/${id}`, JSON.stringify({ id, body: 'x' }), { qos: 1 }, (error) => {
					clearTimeout(timer);
					resolvePromise(error ? (error as any).code : 0);
				});
			});
		} finally {
			await new Promise<void>((resolvePromise) => mqttClient.end(true, {}, () => resolvePromise()));
		}
	}

	function rest(method: 'put' | 'patch' | 'delete' | 'post', path: string) {
		return request(ctx.harper.httpURL)[method](path).set(client.headers);
	}

	function op(body: Record<string, unknown>) {
		return client.req().send({ database: 'readonlytest', table: 'Note', ...body });
	}

	function assertReadOnly(r: any) {
		strictEqual(r.status, 405, `${r.status} ${r.text}`);
		ok(r.text.includes(READ_ONLY), r.text);
		ok(!r.text.includes('ifVersion'), r.text);
	}

	test('REST PUT is refused with a 405', async () => {
		assertReadOnly(await rest('put', '/Note/rest-put').send({ id: 'rest-put', body: 'x' }));
	});

	test('REST PATCH is refused with a 405', async () => {
		assertReadOnly(await rest('patch', '/Note/seed').send({ body: 'changed' }));
	});

	test('REST DELETE is refused with a 405', async () => {
		assertReadOnly(await rest('delete', '/Note/seed'));
	});

	test('REST POST is refused with a 405', async () => {
		assertReadOnly(await rest('post', '/Note/').send({ id: 'rest-post', body: 'x' }));
	});

	for (const operation of ['insert', 'upsert']) {
		test(`operations API ${operation} is refused with a 405`, async () => {
			assertReadOnly(await op({ operation, records: [{ id: `ops-${operation}`, body: 'x' }] }));
		});
	}

	test('operations API update is refused with a 405', async () => {
		assertReadOnly(await op({ operation: 'update', records: [{ id: 'seed', body: 'changed' }] }));
	});

	test('operations API delete is refused with a 405', async () => {
		assertReadOnly(await op({ operation: 'delete', hash_values: ['seed'] }));
	});

	test('an insert that needs a new id range is refused with a 405', async () => {
		assertReadOnly(await op({ operation: 'insert', table: 'Dyn', records: [{ known: 'b' }] }));
	});

	test('an insert that adds an attribute is refused with a 405', async () => {
		assertReadOnly(await op({ operation: 'insert', table: 'Dyn', records: [{ id: 2, brandNew: 'b' }] }));
	});

	test('MQTT publish is refused', { skip: skipMqtt }, async () => {
		ok((await mqttPublish('mqtt-publish')) >= 0x80, 'expected a failure PUBACK');
	});

	test('nothing was written, and reads still work', async () => {
		const seed = await client.reqRest('/Note/seed').expect(200);
		strictEqual(seed.body.body, 'seed');
		const dyn = await op({
			operation: 'search_by_value',
			table: 'Dyn',
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['*'],
		}).expect(200);
		strictEqual(dyn.body.length, 1, JSON.stringify(dyn.body));
		for (const id of ['rest-put', 'rest-post', 'ops-insert', 'ops-upsert']) {
			await client.reqRest(`/Note/${id}`).expect(404);
		}
	});

	test('the refused writes left nothing behind once the server is writable again', async () => {
		await killHarper(ctx);
		await startHarper(ctx, { env: {} });
		client = createApiClient(ctx.harper);
		strictEqual((await client.reqRest('/Note/seed').expect(200)).body.body, 'seed');
		const dyn = await op({
			operation: 'search_by_value',
			table: 'Dyn',
			search_attribute: 'id',
			search_value: '*',
			get_attributes: ['*'],
		}).expect(200);
		strictEqual(dyn.body.length, 1, JSON.stringify(dyn.body));
		const description = await client
			.req()
			.send({ operation: 'describe_table', database: 'readonlytest', table: 'Dyn' })
			.expect(200);
		ok(!JSON.stringify(description.body.attributes).includes('brandNew'), JSON.stringify(description.body.attributes));
		await request(ctx.harper.httpURL)
			.put('/Note/writable')
			.set(client.headers)
			.send({ id: 'writable', body: 'ok' })
			.expect(204);
	});
});
