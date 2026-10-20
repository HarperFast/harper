/**
 * Attribute read permissions apply to subscription deliveries over SSE, REST WebSocket and MQTT, for a
 * role that cannot read `secret` and cannot update `locked` or `secret` of `Doc`.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/subscription-attribute-permissions.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import WebSocket from 'ws';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient, createHeaders } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/subscription-attribute-permissions');
// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun — the same skip the MQTT suites carry.
const skipMqtt = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const ROLE = 'doc_no_secret_role';
const USER = { username: 'doc_no_secret_user', password: 'Doc-no-secret-1!' };
const SECRET = 'TOPSECRET';

interface Frames {
	frames: string[];
	close: () => void;
}

function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return (async () => {
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await sleep(30);
		}
		return predicate();
	})();
}

suite('Attribute read permissions on subscription deliveries', (ctx: ContextWithHarper) => {
	let apiClient: ReturnType<typeof createApiClient>;
	let restURL: string;
	let wsBase: string;
	let adminAuth: string;
	let userAuth: string;
	const open: Array<{ close: () => void }> = [];

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { config: {}, env: {} });
		apiClient = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;
		wsBase = restURL.replace(/^http/, 'ws');
		adminAuth = apiClient.headers.Authorization;
		userAuth = createHeaders(USER.username, USER.password).Authorization;
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
								{ attribute_name: 'locked', read: true, insert: false, update: false },
								{ attribute_name: 'secret', read: false, insert: false, update: false },
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
		for (const subscription of open) subscription.close();
		await teardownHarper(ctx);
	});

	async function write(method: 'PUT' | 'PATCH', id: string, body: object, auth = adminAuth) {
		const res = await fetch(`${restURL}/Doc/${id}`, {
			method,
			headers: { 'Content-Type': 'application/json', 'Authorization': auth },
			body: JSON.stringify(body),
		});
		ok(res.ok, `${method} ${id}: ${res.status} ${await res.text()}`);
	}
	const putAsAdmin = (id: string, title: string) =>
		write('PUT', id, { id, title, locked: 'locked value', secret: `${SECRET} of ${id}` });

	async function storedAsAdmin(id: string) {
		const res = await fetch(`${restURL}/Doc/${id}`, { headers: { Authorization: adminAuth } });
		strictEqual(res.status, 200);
		return res.json();
	}

	function openSse(path: string, auth: string): Frames {
		const url = new URL(restURL);
		const frames: string[] = [];
		const req = httpRequest(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port,
				path,
				headers: { Accept: 'text/event-stream', Authorization: auth },
			},
			(res) => {
				res.setEncoding('utf8');
				let pending = '';
				res.on('data', (chunk: string) => {
					const blocks = (pending + chunk).split('\n\n');
					pending = blocks.pop()!;
					for (const block of blocks) {
						const data = block
							.split('\n')
							.filter((line) => line.startsWith('data:'))
							.map((line) => line.slice(5).trimStart())
							.join('\n');
						if (data) frames.push(data);
					}
				});
			}
		);
		req.on('error', () => {});
		req.end();
		const subscription = { frames, close: () => req.destroy() };
		open.push(subscription);
		return subscription;
	}

	async function openWs(path: string, auth: string): Promise<Frames> {
		const ws = new WebSocket(`${wsBase}${path}`, { headers: { Authorization: auth } });
		const frames: string[] = [];
		ws.on('message', (data: Buffer) => frames.push(data.toString()));
		ws.on('error', () => {});
		await new Promise((res, reject) => {
			ws.once('open', res);
			ws.once('error', reject);
		});
		const subscription = { frames, close: () => ws.terminate() };
		open.push(subscription);
		return subscription;
	}

	function connectMqtt(clientId: string, auth: { username: string; password: string }, clean = true) {
		const frames: string[] = [];
		const options: IClientOptions = {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 8000,
			clean,
			clientId,
			...auth,
		};
		return new Promise<{ client: MqttClient; frames: string[] }>((res, reject) => {
			const client = mqtt.connect(`${wsBase}/mqtt`, options);
			// a resumed session replays as soon as it is accepted
			client.on('message', (_topic, payload) => frames.push(payload.toString()));
			client.once('connect', () => {
				client.on('error', () => {});
				open.push({ close: () => client.end(true) });
				res({ client, frames });
			});
			client.once('error', reject);
		});
	}
	const admin = () => ({ username: ctx.harper.admin.username, password: ctx.harper.admin.password });

	function subscribeMqtt(client: MqttClient, topic: string, qos: 0 | 1) {
		return new Promise<void>((res, reject) =>
			client.subscribe(topic, { qos }, (error) => (error ? reject(error) : res()))
		);
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

	const hasTitle = (frames: string[], title: string) => frames.some((frame) => frame.includes(`"${title}"`));
	async function assertDelivered(label: string, frames: string[], titles: string[], secretVisible: boolean) {
		for (const title of titles) ok(await waitFor(() => hasTitle(frames, title)), `${label}: ${title} delivered`);
		for (const frame of frames) {
			ok(!frame.includes('metadataFlags'), `${label}: ${frame}`);
			if (!secretVisible) ok(!frame.includes(SECRET), `${label}: ${frame}`);
			if (!frame.includes('"title"')) continue;
			ok(frame.includes('locked value'), `${label}: ${frame}`);
			if (secretVisible) ok(frame.includes(SECRET), `${label}: ${frame}`);
		}
	}

	// a put superseded before it is delivered may be coalesced into the next write, so each is awaited
	async function writeSequence(id: string, prefix: string, streams: string[][]) {
		const deliveredToAll = (title: string) => waitFor(() => streams.every((frames) => hasTitle(frames, title)));
		ok(await deliveredToAll(`${prefix} current`), `${prefix}: the current record is delivered`);
		await putAsAdmin(id, `${prefix} put`);
		ok(await deliveredToAll(`${prefix} put`), `${prefix}: the put is delivered`);
		await write('PATCH', id, { title: `${prefix} patch` });
		return [`${prefix} current`, `${prefix} put`, `${prefix} patch`];
	}

	test('SSE deliveries omit attributes the role cannot read', async () => {
		await putAsAdmin('sse-1', 'sse current');
		const restricted = openSse('/Doc/sse-1', userAuth);
		const collection = openSse('/Doc/', userAuth);
		const superUser = openSse('/Doc/sse-1', adminAuth);
		const titles = await writeSequence('sse-1', 'sse', [restricted.frames, collection.frames, superUser.frames]);
		await assertDelivered('restricted SSE', restricted.frames, titles, false);
		await assertDelivered('restricted collection SSE', collection.frames, titles, false);
		await assertDelivered('super user SSE', superUser.frames, titles, true);
	});

	test('REST WebSocket deliveries omit attributes the role cannot read', async () => {
		await putAsAdmin('ws-1', 'ws current');
		const restricted = await openWs('/Doc/ws-1', userAuth);
		const superUser = await openWs('/Doc/ws-1', adminAuth);
		const titles = await writeSequence('ws-1', 'ws', [restricted.frames, superUser.frames]);
		await assertDelivered('restricted WebSocket', restricted.frames, titles, false);
		await assertDelivered('super user WebSocket', superUser.frames, titles, true);
	});

	for (const qos of [0, 1] as const) {
		test(`MQTT QoS ${qos} deliveries omit attributes the role cannot read`, { skip: skipMqtt }, async () => {
			const id = `mqtt${qos}-1`;
			await putAsAdmin(id, `mqtt${qos} current`);
			const restricted = await connectMqtt(`restricted-${id}`, USER);
			const superUser = await connectMqtt(`admin-${id}`, admin());
			await subscribeMqtt(restricted.client, `Doc/${id}`, qos);
			await subscribeMqtt(superUser.client, `Doc/${id}`, qos);
			const titles = await writeSequence(id, `mqtt${qos}`, [restricted.frames, superUser.frames]);
			await assertDelivered(`restricted MQTT QoS ${qos}`, restricted.frames, titles, false);
			await assertDelivered(`super user MQTT QoS ${qos}`, superUser.frames, titles, true);
		});
	}

	test('a resumed MQTT session replays without attributes the role cannot read', { skip: skipMqtt }, async () => {
		await putAsAdmin('resume-1', 'resume current');
		const clientId = 'restricted-resume-1';
		const first = await connectMqtt(clientId, USER, false);
		await subscribeMqtt(first.client, 'Doc/resume-1', 1);
		ok(await waitFor(() => hasTitle(first.frames, 'resume current')), 'the current record is delivered');
		await new Promise((res) => first.client.end(false, {}, res));
		await putAsAdmin('resume-1', 'resume offline put');
		await write('PATCH', 'resume-1', { title: 'resume offline patch' });
		const resumed = await connectMqtt(clientId, USER, false);
		await assertDelivered(
			'resumed MQTT session',
			resumed.frames,
			['resume offline put', 'resume offline patch'],
			false
		);
	});

	test(
		'a non-retained MQTT publish delivers and records exactly the published fields',
		{ skip: skipMqtt },
		async () => {
			await putAsAdmin('pub-1', 'pub stored');
			const superUser = await connectMqtt('admin-pub-1', admin());
			await subscribeMqtt(superUser.client, 'Doc/pub-1', 1);
			ok(await waitFor(() => hasTitle(superUser.frames, 'pub stored')), 'the current record is delivered');
			const publisher = await connectMqtt('restricted-pub-1', USER);
			strictEqual(await publish(publisher.client, 'Doc/pub-1', { title: 'pub message' }, false), 0);
			ok(await waitFor(() => hasTitle(superUser.frames, 'pub message')), 'the message is delivered');
			deepStrictEqual(JSON.parse(superUser.frames.find((frame) => frame.includes('pub message'))!), {
				title: 'pub message',
			});
			const audit = await apiClient.req().send({
				operation: 'read_audit_log',
				schema: 'data',
				table: 'Doc',
				search_type: 'hash_value',
				search_values: ['pub-1'],
			});
			strictEqual(audit.status, 200, audit.text);
			const entry = audit.body['pub-1'].find((entry: any) => entry.records?.[0]?.title === 'pub message');
			ok(entry, JSON.stringify(audit.body));
			deepStrictEqual(entry.records[0], { title: 'pub message' });
			strictEqual((await storedAsAdmin('pub-1')).title, 'pub stored');
		}
	);

	test('a retained publish or full PUT by the role keeps attributes it cannot update', async (t) => {
		const expected = (id: string, title: string) => ({
			id,
			title,
			locked: 'locked value',
			secret: `${SECRET} of ${id}`,
		});
		await putAsAdmin('keep-put', 'stored');
		await write('PUT', 'keep-put', { id: 'keep-put', title: 'put by role' }, userAuth);
		deepStrictEqual(await storedAsAdmin('keep-put'), expected('keep-put', 'put by role'));
		if (skipMqtt) return t.skip('MQTT is not available on this runtime');
		await putAsAdmin('keep-retain', 'stored');
		const publisher = await connectMqtt('restricted-keep-retain', USER);
		strictEqual(await publish(publisher.client, 'Doc/keep-retain', { title: 'retained by role' }, true), 0);
		deepStrictEqual(await storedAsAdmin('keep-retain'), expected('keep-retain', 'retained by role'));
	});
});
