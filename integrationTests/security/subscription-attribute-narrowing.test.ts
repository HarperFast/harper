/**
 * An open SSE, REST WebSocket or MQTT subscription ends once its role can no longer read an attribute it could read
 * when the subscription was admitted, whether `alter_role` narrows the role or `alter_user` moves the user to a
 * narrower one. Super-user and unchanged-role subscriptions keep delivering.
 *
 * The periodic pass is off, so every ending comes from the recheck the role or user change triggers.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/subscription-attribute-narrowing.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
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

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/subscription-attribute-narrowing');
// as in subscription-attribute-permissions.test.ts: mqtt.js over WebSocket and REST WebSocket misbehave on Bun
const skipWebSocket = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const WIDE_ROLE = 'narrowing_wide_role';
const NARROW_ROLE = 'narrowing_narrow_role';
const PASSWORD = 'Narrowing-pw-1!';
const NOTE = 'NOTEVALUE';

const docRole = (readable: string[]) => ({
	super_user: false,
	data: {
		tables: {
			Doc: {
				read: true,
				insert: false,
				update: false,
				delete: false,
				attribute_permissions: readable.map((attribute_name) => ({
					attribute_name,
					read: true,
					insert: false,
					update: false,
				})),
			},
		},
	},
});

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

suite('Narrowing attribute read permissions ends open subscriptions', (ctx: ContextWithHarper) => {
	let apiClient: ReturnType<typeof createApiClient>;
	let restURL: string;
	let wsBase: string;
	let seq = 0;
	const open: Array<{ close: () => void }> = [];
	let superUserStream: string[];
	let steadyStream: string[];

	const operation = async (body: object) => {
		const response = await apiClient.req().send(body);
		strictEqual(response.status, 200, `${JSON.stringify(body)}: ${response.text}`);
	};
	const auth = (username: string) => createHeaders(username, PASSWORD).Authorization;
	const addUser = (username: string, role: string) =>
		operation({ operation: 'add_user', role, username, password: PASSWORD, active: true });

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {},
			env: { HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS: '600000' },
		});
		apiClient = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;
		wsBase = restURL.replace(/^http/, 'ws');
		await waitForRouteReady(apiClient, '/Doc/', 120_000);
		await operation({ operation: 'add_role', role: WIDE_ROLE, permission: docRole(['title', 'note']) });
		await operation({ operation: 'add_role', role: NARROW_ROLE, permission: docRole(['title']) });
		await addUser('narrowing_steady', WIDE_ROLE);
		superUserStream = openSse(apiClient.headers.Authorization).frames;
		steadyStream = openSse(auth('narrowing_steady')).frames;
		await putDoc('oracles ready');
		ok(await waitFor(() => [superUserStream, steadyStream].every((frames) => hasNote(frames, 'oracles ready'))));
	});

	after(async () => {
		for (const subscription of open) subscription.close();
		await teardownHarper(ctx);
	});

	const noteOf = (title: string) => `${NOTE} of ${title}`;
	const hasNote = (frames: string[], title: string) => frames.some((frame) => frame.includes(noteOf(title)));
	const hasTitle = (frames: string[], title: string) => frames.some((frame) => frame.includes(`"${title}"`));

	async function putDoc(title: string) {
		const id = `doc-${seq++}`;
		const response = await fetch(`${restURL}/Doc/${id}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'Authorization': apiClient.headers.Authorization },
			body: JSON.stringify({ id, title, note: noteOf(title) }),
		});
		ok(response.ok, `PUT ${id}: ${response.status} ${await response.text()}`);
	}

	function openSse(authorization: string) {
		const url = new URL(restURL);
		const frames: string[] = [];
		let closed = false;
		const req = httpRequest(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port,
				path: '/Doc/',
				headers: { Accept: 'text/event-stream', Authorization: authorization },
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
							.map((line) => line.slice(5))
							.join('\n');
						if (data) frames.push(data);
					}
				});
				res.on('close', () => (closed = true));
			}
		);
		req.on('error', () => {});
		req.end();
		open.push({ close: () => req.destroy() });
		return { frames, closed: () => closed };
	}

	async function openWs(authorization: string) {
		const ws = new WebSocket(`${wsBase}/Doc/`, { headers: { Authorization: authorization } });
		const frames: string[] = [];
		let closed = false;
		ws.on('message', (data: Buffer) => frames.push(data.toString()));
		ws.on('close', () => (closed = true));
		ws.on('error', () => {});
		await new Promise((res, reject) => {
			ws.once('open', res);
			ws.once('error', reject);
		});
		open.push({ close: () => ws.terminate() });
		return { frames, closed: () => closed };
	}

	async function connectMqtt(username: string) {
		const frames: string[] = [];
		const options: IClientOptions = {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 8000,
			clean: true,
			clientId: `${username}-${seq++}`,
			username,
			password: PASSWORD,
		};
		const client = await new Promise<MqttClient>((res, reject) => {
			const connecting = mqtt.connect(`${wsBase}/mqtt`, options);
			connecting.on('message', (_topic, payload) => frames.push(payload.toString()));
			connecting.once('connect', () => {
				connecting.on('error', () => {});
				open.push({ close: () => connecting.end(true) });
				res(connecting);
			});
			connecting.once('error', reject);
		});
		/** Resolves with the granted QoS: 128 or more, or none, when refused. */
		const subscribe = () =>
			new Promise<number | undefined>((res) =>
				client.subscribe('Doc/#', { qos: 1 }, (error, granted) => res(error ? 128 : granted?.[0]?.qos))
			);
		return { frames, subscribe };
	}

	async function assertNoteDelivered(frames: string[], label: string) {
		const title = `${label} before`;
		await putDoc(title);
		ok(await waitFor(() => hasNote(frames, title)), `${label}: note is delivered while the role can read it`);
	}

	// a probe written before the recheck landed may still arrive with the old projection
	async function assertEnded(frames: string[], label: string) {
		const deadline = Date.now() + 20_000;
		let ended = false;
		while (!ended && Date.now() < deadline) {
			const title = `${label} probe ${seq}`;
			await putDoc(title);
			ok(
				await waitFor(() => hasNote(superUserStream, title) && hasNote(steadyStream, title)),
				`${label}: the super-user and unchanged-role subscriptions keep delivering note`
			);
			await sleep(300);
			ended = !hasTitle(frames, title);
		}
		ok(ended, `${label}: the subscription kept delivering after its role lost read on note`);
		const delivered = frames.length;
		const title = `${label} after`;
		await putDoc(title);
		ok(await waitFor(() => hasNote(superUserStream, title) && hasNote(steadyStream, title)));
		await sleep(500);
		strictEqual(frames.length, delivered, `${label}: delivered after it ended: ${frames.slice(delivered)}`);
	}

	const narrowRole = (role: string) => operation({ operation: 'alter_role', id: role, permission: docRole(['title']) });
	const moveToNarrowRole = (username: string) => operation({ operation: 'alter_user', username, role: NARROW_ROLE });

	async function roleOf(label: string) {
		const role = `narrowing_${label}_role`;
		await operation({ operation: 'add_role', role, permission: docRole(['title', 'note']) });
		const username = `narrowing_${label}`;
		await addUser(username, role);
		return { role, username };
	}

	test('alter_role ends an SSE subscription', async () => {
		const { role, username } = await roleOf('sse');
		const stream = openSse(auth(username));
		await assertNoteDelivered(stream.frames, 'SSE alter_role');
		await narrowRole(role);
		await assertEnded(stream.frames, 'SSE alter_role');
		ok(await waitFor(stream.closed), 'the SSE response closes');
	});

	test('alter_user ends an SSE subscription', async () => {
		const username = 'narrowing_sse_user';
		await addUser(username, WIDE_ROLE);
		const stream = openSse(auth(username));
		await assertNoteDelivered(stream.frames, 'SSE alter_user');
		await moveToNarrowRole(username);
		await assertEnded(stream.frames, 'SSE alter_user');
		ok(await waitFor(stream.closed), 'the SSE response closes');
	});

	test('alter_role ends a REST WebSocket subscription', { skip: skipWebSocket }, async () => {
		const { role, username } = await roleOf('ws');
		const socket = await openWs(auth(username));
		await assertNoteDelivered(socket.frames, 'WebSocket alter_role');
		await narrowRole(role);
		await assertEnded(socket.frames, 'WebSocket alter_role');
		ok(await waitFor(socket.closed), 'the WebSocket closes');
	});

	test('alter_role ends an MQTT subscription', { skip: skipWebSocket }, async () => {
		const { role, username } = await roleOf('mqtt');
		const connection = await connectMqtt(username);
		ok(((await connection.subscribe()) ?? 128) < 128, 'the subscription is granted');
		await assertNoteDelivered(connection.frames, 'MQTT alter_role');
		await narrowRole(role);
		await assertEnded(connection.frames, 'MQTT alter_role');
	});

	test('alter_user ends an MQTT subscription', { skip: skipWebSocket }, async () => {
		const username = 'narrowing_mqtt_user';
		await addUser(username, WIDE_ROLE);
		const connection = await connectMqtt(username);
		ok(((await connection.subscribe()) ?? 128) < 128, 'the subscription is granted');
		await assertNoteDelivered(connection.frames, 'MQTT alter_user');
		await moveToNarrowRole(username);
		await assertEnded(connection.frames, 'MQTT alter_user');
	});

	test(
		'a SUBSCRIBE on an MQTT connection authenticated before alter_role delivers no note',
		{ skip: skipWebSocket },
		async () => {
			const { role, username } = await roleOf('mqtt_stale');
			await putDoc('stale stored');
			const connection = await connectMqtt(username);
			await narrowRole(role);
			// the user-change notification reaches every thread
			await sleep(1000);
			const granted = await connection.subscribe();
			await putDoc('stale after');
			ok(await waitFor(() => hasNote(superUserStream, 'stale after')));
			await sleep(500);
			ok(!connection.frames.some((frame) => frame.includes(NOTE)), `delivered: ${connection.frames}`);
			ok(granted === undefined || granted >= 128, `the SUBSCRIBE was granted QoS ${granted}`);
		}
	);
});
