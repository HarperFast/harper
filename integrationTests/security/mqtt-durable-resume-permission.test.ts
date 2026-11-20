/**
 * What a durable MQTT session (clean: false, QoS 1) is sent when it reconnects after its role's read permission
 * changed while it was offline. The reference says a durable session catches up its subscribed topics at reconnect
 * (docs/reference/mqtt/overview.md, Durable Sessions) and that a role reads only the tables and attributes it is
 * granted (docs/reference/users-and-roles/overview.md); it does not say which permission the catch-up uses. This
 * suite pins that the permission at reconnect decides.
 *
 *   A  unchanged role: the offline backlog of both tables arrives on resume (positive control).
 *   B  table read removed while offline: no DurableFeed frame arrives on resume; a fresh connection shows the
 *      change took effect (DurableFeed SUBSCRIBE refused, DurableOther still delivers). Then read is restored: the
 *      session resumes, the other table's backlog arrived on one of the two resumes and new DurableFeed writes
 *      arrive. Whether the DurableFeed writes made while read was denied arrive is reported, not asserted (#2943
 *      decides whether the session keeps a topic it can no longer subscribe to).
 *   C  attribute `secret` denied while offline: the backlog arrives without `secret`.
 *   D1 a QoS 1 delivery left unacknowledged before `secret` was denied is sent again on resume without `secret`.
 *   D2 a QoS 1 delivery left unacknowledged before table read was removed is not sent again; the same steps for a
 *      control user whose role did not change do send it again.
 *
 * A refused resume may end the connection as not authorized (today) or go on to deliver what the role can still
 * read (one of #2943's options). B and D2 accept both and assert the denied table's absence either way.
 *
 * Env: DURABLE_RESUME_THREADS (worker count, default 1). With more than one worker a role change is taken as
 * visible after 8 reads per worker in a row on fresh connections. Connections are hashed to workers, so that makes
 * a worker still holding the old role unlikely, not impossible; such a run fails, it does not pass wrongly.
 *
 * Reproduction:
 *   npm run test:integration -- "integrationTests/security/mqtt-durable-resume-permission.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
// @ts-expect-error lifecycle.mjs has no type declarations; runtime resolves fine
import { waitForRouteReady } from '../apiTests/utils/lifecycle.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/mqtt-durable-resume-permission');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';
const THREADS = Number(process.env.DURABLE_RESUME_THREADS ?? 1);
const SETTLE_MS = 4000;
const REQUEST_MS = 10_000;
const NOT_AUTHORIZED = 'server DISCONNECT 0x87';

interface Frame {
	topic: string;
	text: string;
	json: any;
}
interface Conn {
	client?: MqttClient;
	sessionPresent?: boolean;
	connectError?: string;
	frames: Frame[];
	events: string[];
}
type Principal = { roleId: string; user: { username: string; password: string }; clientId: string };

const TABLE_FULL = { read: true, insert: false, update: false, delete: false, attribute_permissions: [] };
const TABLE_NONE = { read: false, insert: false, update: false, delete: false, attribute_permissions: [] };
const TABLE_NO_SECRET = {
	read: true,
	insert: false,
	update: false,
	delete: false,
	attribute_permissions: [
		{ attribute_name: 'id', read: true, insert: false, update: false },
		{ attribute_name: 'title', read: true, insert: false, update: false },
		{ attribute_name: 'secret', read: false, insert: false, update: false },
	],
};
const permission = (feed: object, other: object) => ({
	super_user: false,
	data: { tables: { DurableFeed: feed, DurableOther: other } },
});

suite(
	'A durable MQTT session resumes under the permission its role has at reconnect',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		let api: ReturnType<typeof createApiClient>;
		let httpURL: string;
		let mqttURL: string;
		const open: MqttClient[] = [];

		const waitFor = async (predicate: () => boolean, timeoutMs = 10_000) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (predicate()) return true;
				await sleep(25);
			}
			return predicate();
		};
		const basic = (user: { username: string; password: string }) =>
			`Basic ${Buffer.from(`${user.username}:${user.password}`).toString('base64')}`;

		async function makePrincipal(arm: string, feed: object, other: object): Promise<Principal> {
			const roleName = `durable_resume_${arm}`;
			const role = await api
				.req()
				.timeout(REQUEST_MS)
				.send({ operation: 'add_role', role: roleName, permission: permission(feed, other) });
			strictEqual(role.status, 200, role.text);
			const user = { username: `durable_resume_${arm}_user`, password: `Pw1!${randomUUID()}` };
			const added = await api
				.req()
				.timeout(REQUEST_MS)
				.send({ operation: 'add_user', role: roleName, ...user, active: true });
			strictEqual(added.status, 200, added.text);
			return { roleId: role.body.id, user, clientId: `durable-resume-${arm}-${randomUUID().slice(0, 8)}` };
		}
		async function restView(principal: Principal, table: string, id: string) {
			try {
				const response = await fetch(`${httpURL}/${table}/${id}`, {
					headers: { Authorization: basic(principal.user), Connection: 'close' },
					signal: AbortSignal.timeout(2000),
				});
				const text = await response.text();
				return { status: response.status, hasSecret: text.includes('"secret"') };
			} catch {
				return { status: 0, hasSecret: false };
			}
		}
		async function alterRole(
			principal: Principal,
			feed: object,
			other: object,
			shows: () => Promise<boolean>,
			what: string
		) {
			const altered = await api
				.req()
				.timeout(REQUEST_MS)
				.send({ operation: 'alter_role', id: principal.roleId, permission: permission(feed, other) });
			strictEqual(altered.status, 200, altered.text);
			// the resume must not reach a worker that still holds the old role, which would fail the arm for no defect
			const needed = THREADS === 1 ? 2 : THREADS * 8;
			const deadline = Date.now() + 30_000;
			let consecutive = 0;
			while (consecutive < needed && Date.now() < deadline) {
				consecutive = (await shows()) ? consecutive + 1 : 0;
				if (consecutive < needed) await sleep(25);
			}
			strictEqual(consecutive, needed, `the role change never showed on the principal's own reads: ${what}`);
		}
		async function put(table: string, id: string, secret: string) {
			const response = await fetch(`${httpURL}/${table}/${id}`, {
				method: 'PUT',
				headers: { 'Authorization': api.headers.Authorization, 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, title: `t-${id}`, secret }),
				signal: AbortSignal.timeout(REQUEST_MS),
			});
			ok(response.status === 204 || response.status === 200, `PUT ${table}/${id} -> ${response.status}`);
		}

		function connect(
			user: { username: string; password: string },
			extra: Partial<IClientOptions>,
			acknowledge = true
		): Promise<Conn> {
			const conn: Conn = { frames: [], events: [] };
			return new Promise((res) => {
				const options: IClientOptions = {
					protocolVersion: 5,
					reconnectPeriod: 0,
					connectTimeout: 10_000,
					clean: true,
					...user,
					...extra,
				};
				const client = mqtt.connect(mqttURL, options);
				open.push(client);
				conn.client = client;
				if (!acknowledge) {
					// mqtt.js sends the PUBACK from this callback; never calling it leaves the delivery unacknowledged
					(client as any).handleMessage = () => {};
				}
				client.on('message', (topic, payload) => {
					const text = payload.toString();
					let json: any;
					try {
						json = JSON.parse(text);
					} catch {}
					conn.frames.push({ topic, text, json });
				});
				client.on('disconnect', (packet: any) =>
					conn.events.push(`server DISCONNECT 0x${Number(packet?.reasonCode ?? 0).toString(16)}`)
				);
				client.on('close', () => conn.events.push('close'));
				const timer = setTimeout(() => {
					conn.connectError = 'connect timed out';
					res(conn);
				}, 15_000);
				client.once('connect', (connack) => {
					clearTimeout(timer);
					conn.sessionPresent = connack.sessionPresent;
					res(conn);
				});
				client.on('error', (error: any) => {
					conn.events.push(`error: ${error?.code ?? ''} ${error?.message ?? error}`);
					if (conn.sessionPresent === undefined && !conn.connectError) {
						clearTimeout(timer);
						conn.connectError = `${error?.code ?? ''} ${error?.message ?? error}`;
						res(conn);
					}
				});
			});
		}
		function subscribe(conn: Conn, topic: string) {
			return new Promise<string>((res) => {
				const timer = setTimeout(() => res('timeout'), 10_000);
				conn.client!.subscribe(topic, { qos: 1 }, (err: any, granted: any) => {
					clearTimeout(timer);
					if (err) {
						const raw = err?.packet?.granted;
						res(`refused ${Array.isArray(raw) ? '0x' + raw[0].toString(16) : (err.code ?? err.message)}`);
					} else res(`granted ${JSON.stringify(granted?.map((g: any) => g.qos))}`);
				});
			});
		}
		const endGracefully = (conn: Conn) =>
			new Promise<void>((res) => {
				const timer = setTimeout(res, 3000);
				conn.client!.end(false, {}, () => {
					clearTimeout(timer);
					res();
				});
			});
		const drop = (conn: Conn) => new Promise<void>((res) => conn.client!.end(true, {}, () => res()));
		const ids = (conn: Conn, table: string) =>
			conn.frames
				.filter((frame) => frame.topic.startsWith(`${table}/`))
				.map((frame) => frame.topic.slice(table.length + 1));
		const hasAll = (conn: Conn, table: string, expected: string[]) =>
			expected.every((id) => ids(conn, table).includes(id));
		const describe = (conn: Conn) =>
			JSON.stringify({
				sessionPresent: conn.sessionPresent,
				connectError: conn.connectError,
				events: conn.events,
				frames: conn.frames.map((frame) => `${frame.topic} ${frame.text}`),
			});

		// an empty frame list proves a refusal only once the resume is known to have run
		async function refusedResume(principal: Principal, readableTable: string, readableBacklog: string[]) {
			const conn = await connect(principal.user, { clean: false, clientId: principal.clientId });
			strictEqual(conn.connectError, undefined, describe(conn));
			strictEqual(conn.sessionPresent, true, describe(conn));
			const settled = await waitFor(
				() => conn.events.includes(NOT_AUTHORIZED) || hasAll(conn, readableTable, readableBacklog),
				15_000
			);
			ok(settled, `the resume neither refused nor delivered what the role can read: ${describe(conn)}`);
			if (!conn.events.includes(NOT_AUTHORIZED)) await sleep(SETTLE_MS);
			return conn;
		}
		async function openDurable(arm: string, principal: Principal, topics: string[]) {
			const conn = await connect(principal.user, { clean: false, clientId: principal.clientId });
			strictEqual(conn.connectError, undefined, `${arm}: first connect failed: ${describe(conn)}`);
			for (const topic of topics) {
				const suback = await subscribe(conn, topic);
				ok(suback.startsWith('granted'), `${arm}: SUBSCRIBE ${topic} -> ${suback}`);
			}
			for (const topic of topics) {
				const table = topic.split('/')[0];
				await put(table, `${arm}-live`, `${arm}-live-secret-${table}`);
				ok(
					await waitFor(() => ids(conn, table).includes(`${arm}-live`)),
					`${arm}: live control on ${table} never arrived: ${describe(conn)}`
				);
			}
			return conn;
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { threads: { count: THREADS }, authentication: { authorizeLocal: false } },
				env: { AUTHENTICATION_AUTHORIZELOCAL: 'false' },
			});
			api = createApiClient(ctx.harper);
			httpURL = ctx.harper.httpURL;
			mqttURL = `${httpURL.replace(/^http/, 'ws')}/mqtt`;
			await waitForRouteReady(api, '/DurableFeed/', 120_000);
			await waitForRouteReady(api, '/DurableOther/', 60_000);
		});
		after(async () => {
			for (const client of open) {
				try {
					client.end(true);
				} catch {}
			}
			await teardownHarper(ctx);
		});

		test('P: a request without credentials is refused (local requests are not the super user)', async () => {
			const response = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ operation: 'describe_all' }),
				signal: AbortSignal.timeout(REQUEST_MS),
			});
			strictEqual(response.status, 401);
			const configuration = await api.req().timeout(REQUEST_MS).send({ operation: 'get_configuration' });
			strictEqual(configuration.status, 200, configuration.text);
			strictEqual(configuration.body?.threads?.count, THREADS, 'the instance runs the worker count this run asked for');
		});

		test('A: an unchanged role receives the offline backlog of both tables on resume', async (t) => {
			const principal = await makePrincipal('a', TABLE_FULL, TABLE_FULL);
			const first = await openDurable('a', principal, ['DurableFeed/#', 'DurableOther/#']);
			await endGracefully(first);
			for (let n = 1; n <= 3; n++) {
				await put('DurableFeed', `a-off-${n}`, `a-secret-feed-${n}`);
				await put('DurableOther', `a-off-${n}`, `a-secret-other-${n}`);
			}
			const resumed = await connect(principal.user, { clean: false, clientId: principal.clientId });
			strictEqual(resumed.connectError, undefined, describe(resumed));
			strictEqual(resumed.sessionPresent, true, describe(resumed));
			const expected = ['a-off-1', 'a-off-2', 'a-off-3'];
			ok(
				await waitFor(() => hasAll(resumed, 'DurableFeed', expected) && hasAll(resumed, 'DurableOther', expected)),
				`the backlog never arrived: ${describe(resumed)}`
			);
			t.diagnostic(`A resumed: ${describe(resumed)}`);
			deepStrictEqual(
				ids(resumed, 'DurableFeed').filter((id) => id.startsWith('a-off-')),
				expected
			);
			deepStrictEqual(
				ids(resumed, 'DurableOther').filter((id) => id.startsWith('a-off-')),
				expected
			);
			ok(
				resumed.frames.every((frame) => typeof frame.json?.secret === 'string'),
				'the full-read role sees secret'
			);
			await endGracefully(resumed);
		});

		test('B: table read removed while offline - no DurableFeed frame on resume; then read restored', async (t) => {
			const principal = await makePrincipal('b', TABLE_FULL, TABLE_FULL);
			const first = await openDurable('b', principal, ['DurableFeed/#', 'DurableOther/#']);
			await endGracefully(first);
			await alterRole(
				principal,
				TABLE_NONE,
				TABLE_FULL,
				async () => (await restView(principal, 'DurableFeed', 'b-live')).status === 403,
				'DurableFeed read removed'
			);
			const offline = ['b-off-1', 'b-off-2', 'b-off-3'];
			for (const id of offline) {
				await put('DurableFeed', id, `b-secret-feed-${id}`);
				await put('DurableOther', id, `b-secret-other-${id}`);
			}
			const resumed = await refusedResume(principal, 'DurableOther', offline);
			t.diagnostic(`B resumed (read on DurableFeed removed): ${describe(resumed)}`);
			deepStrictEqual(
				ids(resumed, 'DurableFeed'),
				[],
				`DurableFeed frames after read was removed: ${describe(resumed)}`
			);
			ok(!resumed.frames.some((frame) => frame.text.includes('b-secret-feed')), describe(resumed));
			if (resumed.client?.connected) await endGracefully(resumed);

			const fresh = await connect(principal.user, { clean: true });
			strictEqual(fresh.connectError, undefined, describe(fresh));
			const feedSuback = await subscribe(fresh, 'DurableFeed/#');
			ok(feedSuback.startsWith('refused'), `fresh SUBSCRIBE DurableFeed/# after read removed -> ${feedSuback}`);
			const fresh2 = await connect(principal.user, { clean: true });
			const otherSuback = await subscribe(fresh2, 'DurableOther/#');
			ok(otherSuback.startsWith('granted'), `fresh SUBSCRIBE DurableOther/# -> ${otherSuback}`);
			await put('DurableOther', 'b-control', 'b-control-secret');
			ok(
				await waitFor(() => ids(fresh2, 'DurableOther').includes('b-control')),
				`control never arrived: ${describe(fresh2)}`
			);
			await drop(fresh);
			await drop(fresh2);

			await alterRole(
				principal,
				TABLE_FULL,
				TABLE_FULL,
				async () => (await restView(principal, 'DurableFeed', 'b-live')).status === 200,
				'DurableFeed read restored'
			);
			await put('DurableFeed', 'b-after-restore', 'b-after-secret');
			const restored = await connect(principal.user, { clean: false, clientId: principal.clientId });
			const acrossResumes = (id: string) =>
				ids(resumed, 'DurableOther').includes(id) || ids(restored, 'DurableOther').includes(id);
			ok(
				await waitFor(() => ids(restored, 'DurableFeed').includes('b-after-restore') && offline.every(acrossResumes)),
				`the restored resume never delivered: ${describe(resumed)} ${describe(restored)}`
			);
			t.diagnostic(`B resumed (read restored): ${describe(restored)}`);
			t.diagnostic(
				`B MEASURED: DurableFeed writes made while read was denied, delivered after the restore: ${JSON.stringify(
					ids(restored, 'DurableFeed').filter((id) => id.startsWith('b-off-'))
				)}`
			);
			strictEqual(restored.connectError, undefined, describe(restored));
			strictEqual(restored.sessionPresent, true, describe(restored));
			ok(ids(restored, 'DurableFeed').includes('b-after-restore'), describe(restored));
			deepStrictEqual(
				offline.filter((id) => !acrossResumes(id)),
				[],
				`readable backlog lost across the refused and the restored resume: ${describe(resumed)} ${describe(restored)}`
			);
			await endGracefully(restored);
		});

		test('C: attribute read denied while offline - the backlog arrives without it', async (t) => {
			const principal = await makePrincipal('c', TABLE_FULL, TABLE_FULL);
			const first = await openDurable('c', principal, ['DurableOther/#']);
			ok(
				first.frames.some((frame) => frame.json?.secret === 'c-live-secret-DurableOther'),
				describe(first)
			);
			await endGracefully(first);
			await alterRole(
				principal,
				TABLE_FULL,
				TABLE_NO_SECRET,
				async () => {
					const view = await restView(principal, 'DurableOther', 'c-live');
					return view.status === 200 && !view.hasSecret;
				},
				'secret denied on DurableOther'
			);
			const offline = ['c-off-1', 'c-off-2', 'c-off-3'];
			for (const id of offline) await put('DurableOther', id, `c-secret-other-${id}`);
			const resumed = await connect(principal.user, { clean: false, clientId: principal.clientId });
			ok(
				await waitFor(() => hasAll(resumed, 'DurableOther', offline)),
				`the backlog never arrived: ${describe(resumed)}`
			);
			await sleep(1000);
			t.diagnostic(`C resumed (secret denied): ${describe(resumed)}`);
			strictEqual(resumed.connectError, undefined, describe(resumed));
			deepStrictEqual(
				ids(resumed, 'DurableOther').filter((id) => id.startsWith('c-off-')),
				offline
			);
			for (const frame of resumed.frames) {
				const id = frame.topic.slice('DurableOther/'.length);
				deepStrictEqual(frame.json, { id, title: `t-${id}` }, `${frame.topic} ${frame.text}`);
			}
			await endGracefully(resumed);
		});

		test('D1: a delivery unacknowledged before `secret` was denied is sent again without it', async (t) => {
			const principal = await makePrincipal('d1', TABLE_FULL, TABLE_FULL);
			const first = await connect(principal.user, { clean: false, clientId: principal.clientId }, false);
			strictEqual(first.connectError, undefined, describe(first));
			// one record's topic: a wildcard would first deliver the table's existing records as retained messages,
			// and the client, which holds its first delivery unacknowledged, would never read the SUBACK behind them
			ok((await subscribe(first, 'DurableOther/d1-unacked')).startsWith('granted'));
			await put('DurableOther', 'd1-unacked', 'd1-secret-unacked');
			ok(await waitFor(() => ids(first, 'DurableOther').includes('d1-unacked')), describe(first));
			strictEqual(first.frames[0].json?.secret, 'd1-secret-unacked', 'delivered in full while permitted');
			await drop(first);
			await alterRole(
				principal,
				TABLE_FULL,
				TABLE_NO_SECRET,
				async () => {
					const view = await restView(principal, 'DurableOther', 'd1-unacked');
					return view.status === 200 && !view.hasSecret;
				},
				'secret denied on DurableOther'
			);
			const resumed = await connect(principal.user, { clean: false, clientId: principal.clientId });
			const sentAgain = await waitFor(() => ids(resumed, 'DurableOther').includes('d1-unacked'));
			await sleep(1000);
			t.diagnostic(`D1 resumed: ${describe(resumed)}`);
			strictEqual(resumed.connectError, undefined, describe(resumed));
			ok(sentAgain, `the unacknowledged delivery was not sent again, so the arm proves nothing: ${describe(resumed)}`);
			for (const frame of resumed.frames)
				deepStrictEqual(frame.json, { id: 'd1-unacked', title: 't-d1-unacked' }, `${frame.topic} ${frame.text}`);
			await endGracefully(resumed);
		});

		test('D2: a delivery unacknowledged before table read was removed is not sent again', async (t) => {
			const control = await makePrincipal('d2c', TABLE_FULL, TABLE_FULL);
			const controlFirst = await connect(control.user, { clean: false, clientId: control.clientId }, false);
			ok((await subscribe(controlFirst, 'DurableFeed/d2-unacked')).startsWith('granted'));
			const principal = await makePrincipal('d2', TABLE_FULL, TABLE_FULL);
			const first = await connect(principal.user, { clean: false, clientId: principal.clientId }, false);
			ok((await subscribe(first, 'DurableFeed/d2-unacked')).startsWith('granted'));
			ok((await subscribe(first, 'DurableOther/d2-readable')).startsWith('granted'));
			await put('DurableFeed', 'd2-unacked', 'd2-secret-unacked');
			ok(await waitFor(() => ids(first, 'DurableFeed').includes('d2-unacked')), describe(first));
			ok(await waitFor(() => ids(controlFirst, 'DurableFeed').includes('d2-unacked')), describe(controlFirst));
			await drop(first);
			await drop(controlFirst);
			await alterRole(
				principal,
				TABLE_NONE,
				TABLE_FULL,
				async () => (await restView(principal, 'DurableFeed', 'd2-unacked')).status === 403,
				'DurableFeed read removed'
			);
			await put('DurableOther', 'd2-readable', 'd2-readable-secret');
			const controlResumed = await connect(control.user, { clean: false, clientId: control.clientId });
			ok(
				await waitFor(() => ids(controlResumed, 'DurableFeed').includes('d2-unacked')),
				`control: an unacknowledged delivery is not sent again at all: ${describe(controlResumed)}`
			);
			await endGracefully(controlResumed);
			const resumed = await refusedResume(principal, 'DurableOther', ['d2-readable']);
			t.diagnostic(`D2 resumed: ${describe(resumed)}`);
			deepStrictEqual(
				ids(resumed, 'DurableFeed'),
				[],
				`DurableFeed frames after read was removed: ${describe(resumed)}`
			);
			ok(!resumed.frames.some((frame) => frame.text.includes('d2-secret')), describe(resumed));
			if (resumed.client?.connected) await endGracefully(resumed);
		});
	}
);
