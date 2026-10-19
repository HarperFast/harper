/**
 * Attribute permissions on REST, GraphQL and MQTT for a role listing only `title` and `owner` of `Doc`
 * (harper#3284, harper#1434).
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/resource-attribute-permissions.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/resource-attribute-permissions');
// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun — the same skip the MQTT suites carry.
const skipMqtt = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const ROLE = 'doc_title_owner_role';
const USER = { username: 'doc_title_owner_user', password: 'Doc-title-owner-3284!' };
const MQTT_NOT_AUTHORIZED = 0x87;

suite('Attribute permissions on the resource path (harper#3284)', (ctx: ContextWithHarper) => {
	let apiClient: ReturnType<typeof createApiClient>;
	let restURL: string;
	let mqttURL: string;
	let adminHeaders: Record<string, string>;
	let userHeaders: Record<string, string>;

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		apiClient = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;
		mqttURL = `${restURL.replace(/^http/, 'ws')}/mqtt`;
		adminHeaders = { 'Content-Type': 'application/json', 'Authorization': apiClient.headers.Authorization };
		userHeaders = createHeaders(USER.username, USER.password);
		await waitForRouteReady(apiClient, '/Doc/', 120_000);

		const role = await apiClient.req().send({
			operation: 'add_role',
			role: ROLE,
			permission: {
				super_user: false,
				data: {
					tables: {
						Doc: {
							read: true,
							insert: true,
							update: true,
							delete: false,
							attribute_permissions: [
								{ attribute_name: 'title', read: true, insert: true, update: true },
								{ attribute_name: 'owner', read: true, insert: true, update: true },
							],
						},
					},
				},
			},
		});
		strictEqual(role.status, 200, role.text);
		const user = await apiClient.req().send({ operation: 'add_user', role: ROLE, ...USER, active: true });
		strictEqual(user.status, 200, user.text);
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	async function seed(id: string) {
		const res = await fetch(`${restURL}/Doc/${id}`, {
			method: 'PUT',
			headers: adminHeaders,
			body: JSON.stringify({ id, title: 'seed title', owner: 'seed owner', secret: `${id} secret` }),
		});
		ok(res.ok, `seeding ${id}: ${res.status} ${await res.text()}`);
	}

	async function storedAsAdmin(id: string) {
		const res = await fetch(`${restURL}/Doc/${id}`, { headers: adminHeaders });
		strictEqual(res.status, 200);
		return res.json();
	}

	function connectAsUser(clientId: string): Promise<MqttClient> {
		const options: IClientOptions = {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 8000,
			clean: true,
			clientId,
			username: USER.username,
			password: USER.password,
		};
		return new Promise((res, reject) => {
			const client = mqtt.connect(mqttURL, options);
			client.once('connect', () => {
				client.on('error', () => {});
				res(client);
			});
			client.once('error', reject);
		});
	}

	/** Resolves with the PUBACK reason code (0 on success). */
	function publish(client: MqttClient, topic: string, payload: object, retain: boolean): Promise<number> {
		return new Promise((res, reject) => {
			const timer = setTimeout(() => reject(new Error(`no PUBACK for ${topic} within 10s`)), 10_000);
			client.publish(topic, JSON.stringify(payload), { qos: 1, retain }, (error: any, packet: any) => {
				clearTimeout(timer);
				res(error ? (error.code ?? -1) : (packet?.reasonCode ?? 0));
			});
		});
	}

	test('REST reads include the unlisted primary key and omit unlisted attributes', async () => {
		await seed('read-1');
		const single = await fetch(`${restURL}/Doc/read-1`, { headers: userHeaders });
		strictEqual(single.status, 200);
		deepStrictEqual(await single.json(), { id: 'read-1', title: 'seed title', owner: 'seed owner' });

		const collection = await fetch(`${restURL}/Doc/?id=read-1`, { headers: userHeaders });
		strictEqual(collection.status, 200);
		deepStrictEqual(await collection.json(), [{ id: 'read-1', title: 'seed title', owner: 'seed owner' }]);

		const selected = await fetch(`${restURL}/Doc/?id=read-1&select(id,title)`, { headers: userHeaders });
		strictEqual(selected.status, 200);
		deepStrictEqual(await selected.json(), [{ id: 'read-1', title: 'seed title' }]);
	});

	test('GraphQL reads include the unlisted primary key', async () => {
		await seed('read-2');
		const res = await fetch(`${restURL}/graphql`, {
			method: 'POST',
			headers: { ...userHeaders, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: '{ Doc(id: "read-2") { id title } }' }),
		});
		const body = await res.json();
		strictEqual(res.status, 200, JSON.stringify(body));
		deepStrictEqual(body.data.Doc, [{ id: 'read-2', title: 'seed title' }]);
	});

	test('REST full PUT without an unwritable attribute keeps its stored value', async () => {
		await seed('put-1');
		const res = await fetch(`${restURL}/Doc/put-1`, {
			method: 'PUT',
			headers: userHeaders,
			body: JSON.stringify({ title: 'new title', owner: 'new owner' }),
		});
		ok(res.ok, `${res.status} ${await res.text()}`);
		deepStrictEqual(await storedAsAdmin('put-1'), {
			id: 'put-1',
			title: 'new title',
			owner: 'new owner',
			secret: 'put-1 secret',
		});
	});

	test('MQTT publish carrying the primary key is accepted', { skip: skipMqtt }, async () => {
		await seed('mqtt-1');
		const client = await connectAsUser('doc-3284-publish');
		try {
			strictEqual(await publish(client, 'Doc/mqtt-1', { id: 'mqtt-1', title: 'published', owner: 'o' }, false), 0);
			strictEqual(await publish(client, 'Doc/mqtt-1', { id: 'mqtt-1', title: 'retained', owner: 'o' }, true), 0);
		} finally {
			client.end(true);
		}
		deepStrictEqual(await storedAsAdmin('mqtt-1'), {
			id: 'mqtt-1',
			title: 'retained',
			owner: 'o',
			secret: 'mqtt-1 secret',
		});
	});

	test('retained MQTT publish without an unwritable attribute keeps its stored value', { skip: skipMqtt }, async () => {
		await seed('mqtt-2');
		const client = await connectAsUser('doc-3284-retain');
		try {
			strictEqual(await publish(client, 'Doc/mqtt-2', { title: 'retained', owner: 'o' }, true), 0);
		} finally {
			client.end(true);
		}
		deepStrictEqual(await storedAsAdmin('mqtt-2'), {
			id: 'mqtt-2',
			title: 'retained',
			owner: 'o',
			secret: 'mqtt-2 secret',
		});
	});

	test('a REST PUT or PATCH setting an unwritable attribute is refused', async () => {
		await seed('put-2');
		const put = await fetch(`${restURL}/Doc/put-2`, {
			method: 'PUT',
			headers: userHeaders,
			body: JSON.stringify({ title: 't', owner: 'o', secret: 'overwritten' }),
		});
		strictEqual(put.status, 403, await put.text());
		const patch = await fetch(`${restURL}/Doc/put-2`, {
			method: 'PATCH',
			headers: userHeaders,
			body: JSON.stringify({ secret: 'overwritten' }),
		});
		strictEqual(patch.status, 403, await patch.text());
		strictEqual((await storedAsAdmin('put-2')).secret, 'put-2 secret');
	});

	test('an MQTT payload setting an unwritable attribute is still refused', { skip: skipMqtt }, async () => {
		await seed('mqtt-3');
		const client = await connectAsUser('doc-3284-refuse');
		try {
			strictEqual(
				await publish(client, 'Doc/mqtt-3', { title: 't', owner: 'o', secret: 'overwritten' }, true),
				MQTT_NOT_AUTHORIZED
			);
		} finally {
			client.end(true);
		}
		strictEqual((await storedAsAdmin('mqtt-3')).secret, 'mqtt-3 secret');
	});

	test('super user full PUT still replaces the whole record', async () => {
		await seed('admin-1');
		const res = await fetch(`${restURL}/Doc/admin-1`, {
			method: 'PUT',
			headers: adminHeaders,
			body: JSON.stringify({ title: 'admin title' }),
		});
		ok(res.ok, `${res.status} ${await res.text()}`);
		deepStrictEqual(await storedAsAdmin('admin-1'), { id: 'admin-1', title: 'admin title' });
	});

	test('a REST PUT or PATCH body with a then field is accepted', async () => {
		for (const [method, body] of [
			['PUT', { title: 'then put', then: 'not a function' }],
			['PATCH', { then: 'patched' }],
		] as const) {
			const res = await fetch(`${restURL}/Doc/then-1`, { method, headers: adminHeaders, body: JSON.stringify(body) });
			ok(res.ok, `${method}: ${res.status} ${await res.text()}`);
		}
	});

	test('operations API behavior is unchanged', async () => {
		await seed('ops-1');
		const asUser = (body: object) => apiClient.reqAs(userHeaders).send(body);
		const read = await asUser({
			operation: 'search_by_id',
			database: 'data',
			table: 'Doc',
			ids: ['ops-1'],
			get_attributes: ['*'],
		});
		strictEqual(read.status, 200, read.text);
		deepStrictEqual(read.body, [{ id: 'ops-1', title: 'seed title', owner: 'seed owner' }]);
		const update = await asUser({
			operation: 'update',
			database: 'data',
			table: 'Doc',
			records: [{ id: 'ops-1', title: 'ops title' }],
		});
		strictEqual(update.status, 200, update.text);
		const put = await asUser({
			operation: 'put',
			database: 'data',
			table: 'Doc',
			records: [{ id: 'ops-1', title: 'ops put' }],
		});
		strictEqual(put.status, 403, put.text);
		deepStrictEqual(await storedAsAdmin('ops-1'), {
			id: 'ops-1',
			title: 'ops title',
			owner: 'seed owner',
			secret: 'ops-1 secret',
		});
	});
});
