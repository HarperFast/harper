/**
 * MQTT publishes by a role under non-empty `attribute_permissions` (docs/reference/users-and-roles/overview.md
 * "Attribute-level"; docs/reference/mqtt/overview.md: a retained publish replaces the record like a PUT, a
 * non-retained one is delivered without a write; security/DESIGN.md "Resource attribute permissions").
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/attribute-permissions-mqtt-write.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/attribute-permissions-primary-key');
// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun — the same skip the MQTT suites carry.
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const MQTT_NOT_AUTHORIZED = 0x87;
const DELIVERY_WAIT_MS = 8_000;
const SILENCE_WAIT_MS = 2_000;

type Who = 'unlisted' | 'listed' | 'denied' | 'protected';
const USERS: Record<Who, { username: string; password: string }> = {
	unlisted: { username: 'mq_unlisted_user', password: 'Mq-unlisted-1!' },
	listed: { username: 'mq_listed_user', password: 'Mq-listed-1!' },
	denied: { username: 'mq_denied_user', password: 'Mq-denied-1!' },
	protected: { username: 'mq_protected_user', password: 'Mq-protected-1!' },
};

interface Subscriber {
	client: MqttClient;
	messages: Map<string, string[]>;
}
interface Published {
	reason: number;
	stored: any | null;
	admin: object[];
	self: object[];
}

suite('MQTT publishes under attribute permissions', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let mqttURL: string;
	let admin: Subscriber;
	const publishers = new Map<Who, MqttClient>();
	const selves = new Map<Who, Subscriber>();
	let sequence = 0;

	const stored = async (id: string): Promise<any | null> => {
		const res = await client
			.req()
			.send({ operation: 'search_by_id', database: 'data', table: 'Doc', ids: [id], get_attributes: ['*'] });
		strictEqual(res.status, 200, res.text);
		return res.body.length > 0 ? res.body[0] : null;
	};
	const seed = async (id: string, secret: string) => {
		const res = await client.req().send({
			operation: 'upsert',
			database: 'data',
			table: 'Doc',
			records: [{ id, title: 'seed title', owner: 'seed owner', secret }],
		});
		strictEqual(res.status, 200, res.text);
	};

	function connect(user: { username: string; password: string }, clientId: string): Promise<MqttClient> {
		const options: IClientOptions = {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 8_000,
			clean: true,
			clientId,
			...user,
		};
		return new Promise((resolveConnect, reject) => {
			const connecting = mqtt.connect(mqttURL, options);
			connecting.once('connect', () => {
				connecting.on('error', () => {});
				resolveConnect(connecting);
			});
			connecting.once('error', reject);
		});
	}
	async function subscriber(user: { username: string; password: string }, clientId: string): Promise<Subscriber> {
		const connected = await connect(user, clientId);
		const messages = new Map<string, string[]>();
		connected.on('message', (topic, payload) => {
			if (!messages.has(topic)) messages.set(topic, []);
			messages.get(topic)!.push(payload.toString());
		});
		return { client: connected, messages };
	}
	function subscribe(subscribed: Subscriber, topic: string): Promise<void> {
		return new Promise((resolveSubscribe, reject) => {
			const timer = setTimeout(() => reject(new Error(`no SUBACK for ${topic} within 10s`)), 10_000);
			subscribed.client.subscribe(topic, { qos: 1 }, (error, granted) => {
				clearTimeout(timer);
				if (error) return reject(error);
				const qos = granted?.[0]?.qos;
				if (qos === undefined || qos > 2) return reject(new Error(`SUBACK ${qos} for ${topic}`));
				resolveSubscribe();
			});
		});
	}
	function unsubscribe(subscribed: Subscriber, topic: string): Promise<void> {
		return new Promise((resolveUnsubscribe, reject) => {
			const timer = setTimeout(() => reject(new Error(`no UNSUBACK for ${topic} within 10s`)), 10_000);
			subscribed.client.unsubscribe(topic, () => {
				clearTimeout(timer);
				resolveUnsubscribe();
			});
		});
	}
	function publish(publisher: MqttClient, topic: string, payload: object, retain: boolean): Promise<number> {
		return new Promise((resolvePublish, reject) => {
			const timer = setTimeout(() => reject(new Error(`no PUBACK for ${topic} within 10s`)), 10_000);
			publisher.publish(topic, JSON.stringify(payload), { qos: 1, retain }, (error: any, packet: any) => {
				clearTimeout(timer);
				resolvePublish(error ? (error.code ?? -1) : (packet?.reasonCode ?? 0));
			});
		});
	}
	async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await sleep(50);
		}
		return predicate();
	}
	const parsed = (messages: string[] | undefined): object[] => (messages ?? []).map((text) => JSON.parse(text));

	async function published(
		who: Who,
		payload: object | ((id: string) => object),
		retain: boolean,
		options: { exists?: boolean; secret?: string; expectDelivery?: boolean } = {}
	): Promise<{ id: string } & Published> {
		const { exists = true, secret = 'S-seed', expectDelivery = true } = options;
		const id = `doc-${sequence++}`;
		const topic = `Doc/${id}`;
		if (exists) await seed(id, secret);
		const self = selves.get(who)!;
		await subscribe(admin, topic);
		await subscribe(self, topic);
		if (exists) {
			const initial = await waitFor(
				() => (admin.messages.get(topic)?.length ?? 0) > 0 && (self.messages.get(topic)?.length ?? 0) > 0,
				DELIVERY_WAIT_MS
			);
			ok(initial, `${who}: no initial retained delivery for ${topic}`);
		}
		admin.messages.set(topic, []);
		self.messages.set(topic, []);
		const reason = await publish(
			publishers.get(who)!,
			topic,
			typeof payload === 'function' ? payload(id) : payload,
			retain
		);
		if (expectDelivery) {
			const delivered = await waitFor(
				() => (admin.messages.get(topic)?.length ?? 0) > 0 && (self.messages.get(topic)?.length ?? 0) > 0,
				DELIVERY_WAIT_MS
			);
			ok(delivered, `${who}: no delivery for ${topic} within ${DELIVERY_WAIT_MS} ms`);
		} else await sleep(SILENCE_WAIT_MS);
		const result = {
			id,
			reason,
			stored: await stored(id),
			admin: parsed(admin.messages.get(topic)),
			self: parsed(self.messages.get(topic)),
		};
		await unsubscribe(admin, topic);
		await unsubscribe(self, topic);
		return result;
	}
	const keysOf = (message: object) => Object.keys(message).sort();

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { threads: { count: 1 } },
			env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
		});
		client = createApiClient(ctx.harper);
		mqttURL = `${ctx.harper.httpURL.replace(/^http/, 'ws')}/mqtt`;
		await waitForRouteReady(client, '/Doc/', 120_000);

		const attribute = (attribute_name: string, allow: boolean) => ({
			attribute_name,
			read: allow,
			insert: allow,
			update: allow,
		});
		const permission = (extra: object[]) => ({
			super_user: false,
			data: {
				tables: {
					Doc: {
						read: true,
						insert: true,
						update: true,
						delete: false,
						attribute_permissions: [attribute('title', true), attribute('owner', true), ...extra],
					},
				},
			},
		});
		const roles: Array<[Who, object]> = [
			['unlisted', permission([])],
			['listed', permission([attribute('id', true)])],
			['denied', permission([attribute('id', false)])],
			['protected', permission([attribute('secret', false)])],
		];
		for (const [who, perm] of roles) {
			const role = await client.req().send({ operation: 'add_role', role: `mq_${who}_role`, permission: perm });
			strictEqual(role.status, 200, role.text);
			const user = await client
				.req()
				.send({ operation: 'add_user', role: `mq_${who}_role`, ...USERS[who], active: true });
			strictEqual(user.status, 200, user.text);
			publishers.set(who, await connect(USERS[who], `mq-publish-${who}`));
			selves.set(who, await subscriber(USERS[who], `mq-self-${who}`));
		}
		admin = await subscriber(ctx.harper.admin, 'mq-admin-subscriber');
	});

	after(async () => {
		try {
			for (const open of [admin, ...selves.values()]) open?.client.end(true);
			for (const open of publishers.values()) open.end(true);
		} finally {
			await teardownHarper(ctx);
		}
	});

	test('a publish carrying the key is granted for an unlisted key and refused for a denied one', async () => {
		for (const retain of [true, false]) {
			for (const who of ['unlisted', 'listed'] as const) {
				const title = `${who} ${retain}`;
				const result = await published(who, (id) => ({ id, title, owner: 'ownerA' }), retain);
				strictEqual(result.reason, 0, `${who} retain=${retain}`);
				if (retain) deepStrictEqual(result.stored, { id: result.id, title, owner: 'ownerA', secret: 'S-seed' });
				else {
					deepStrictEqual(result.stored, { id: result.id, title: 'seed title', owner: 'seed owner', secret: 'S-seed' });
					deepStrictEqual(result.admin, [{ id: result.id, title, owner: 'ownerA' }]);
				}
			}
			const denied = await published('denied', (id) => ({ id, title: 'denied', owner: 'ownerA' }), retain, {
				expectDelivery: false,
			});
			strictEqual(denied.reason, MQTT_NOT_AUTHORIZED, `denied retain=${retain}`);
			deepStrictEqual(denied.stored, { id: denied.id, title: 'seed title', owner: 'seed owner', secret: 'S-seed' });
			deepStrictEqual(denied.admin, [], `denied retain=${retain}: delivered`);
			deepStrictEqual(denied.self, [], `denied retain=${retain}: delivered to itself`);
		}
	});

	test('the key on a delivery follows the same rule: present for an unlisted key, absent for a denied one', async () => {
		const unlisted = await published('unlisted', { title: 'unlisted', owner: 'ownerA' }, true);
		strictEqual(unlisted.reason, 0);
		deepStrictEqual(unlisted.self.map(keysOf), [['id', 'owner', 'title']]);
		deepStrictEqual(unlisted.admin.map(keysOf), [['id', 'owner', 'secret', 'title']]);

		const denied = await published('denied', { title: 'denied', owner: 'ownerA' }, true);
		strictEqual(denied.reason, 0);
		deepStrictEqual(denied.stored, { id: denied.id, title: 'denied', owner: 'ownerA', secret: 'S-seed' });
		deepStrictEqual(denied.self.map(keysOf), [['owner', 'title']]);
		deepStrictEqual(denied.admin.map(keysOf), [['id', 'owner', 'secret', 'title']]);
	});

	test('a retained publish keeps the unlisted attribute and removes the omitted listed one', async () => {
		const result = await published('unlisted', { title: 'only title' }, true);
		strictEqual(result.reason, 0);
		deepStrictEqual(result.stored, { id: result.id, title: 'only title', secret: 'S-seed' });
	});

	test('a delivery carries only what the publisher sent; the stored protected value stays out of it', async () => {
		const live = await published('protected', { title: 'hello' }, false, { secret: 'S-protected' });
		strictEqual(live.reason, 0);
		deepStrictEqual(live.stored, { id: live.id, title: 'seed title', owner: 'seed owner', secret: 'S-protected' });
		deepStrictEqual(live.admin, [{ title: 'hello' }]);
		deepStrictEqual(live.self, [{ title: 'hello' }]);

		const retained = await published('protected', { title: 'hello again' }, true, { secret: 'S-protected' });
		strictEqual(retained.reason, 0);
		deepStrictEqual(retained.stored, { id: retained.id, title: 'hello again', secret: 'S-protected' });
		deepStrictEqual(retained.self, [{ id: retained.id, title: 'hello again' }]);
		deepStrictEqual(retained.admin, [{ id: retained.id, title: 'hello again', secret: 'S-protected' }]);
	});

	test('a retained publish to a record that does not exist creates it under the same rule', async () => {
		const created = await published('unlisted', { title: 'new', owner: 'ownerA' }, true, { exists: false });
		strictEqual(created.reason, 0);
		deepStrictEqual(created.stored, { id: created.id, title: 'new', owner: 'ownerA' });
		deepStrictEqual(created.self, [{ id: created.id, title: 'new', owner: 'ownerA' }]);

		const refused = await published('denied', (id) => ({ id, title: 'new', owner: 'ownerA' }), true, {
			exists: false,
			expectDelivery: false,
		});
		strictEqual(refused.reason, MQTT_NOT_AUTHORIZED);
		strictEqual(refused.stored, null);
		deepStrictEqual(refused.admin, []);
		deepStrictEqual(refused.self, []);

		const keyless = await published('denied', { title: 'new', owner: 'ownerA' }, true, { exists: false });
		strictEqual(keyless.reason, 0);
		deepStrictEqual(keyless.stored, { id: keyless.id, title: 'new', owner: 'ownerA' });
		deepStrictEqual(keyless.self, [{ title: 'new', owner: 'ownerA' }]);
	});
});
