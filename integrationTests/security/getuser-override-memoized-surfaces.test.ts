/**
 * SQA-166 (legs 2–4) — PR #4071 pre-merge: a record-backed user that a MEMOIZING `server.getUser` override
 * built (one object per username, handed to every later lookup) is dropped, deactivated or moved to another
 * role. The documented contract (5.4 release note on the PR head, `subscriptions-of-users-a-getuser-override-builds.md`):
 * a record-backed user "is still revoked when dropped, deactivated or moved to another role"; only a user built
 * "for a name with no `hdb_user` record" is kept as admitted (`docs/reference/database/schema.md:806`).
 *
 * SQA-165 (SP-116) measured that ONE HTTP Basic login after `drop_user` re-tracks the memoized object as
 * recordless (`security/auth.ts:302-305` → `trackUserRecords`, `security/user.ts:659-684`) and that the MQTT
 * surfaces then admit it. This spec asks the legs it did not run:
 *   D   (leg 2) the Bearer-validator login (`security/bearerValidators.ts:101-125`, `trackUserRecords` at :121)
 *       as the re-track instead of Basic — same held-connection SUBSCRIBE split? (a 401 at that login is a fix, not a red)
 *   E1  (leg 3, control) an SSE subscription opened BEFORE `drop_user` by the memoized user ends after it
 *   E2  (leg 3) an SSE subscription opened AFTER `drop_user` — the subscribing request is itself the Basic
 *       re-track — must not deliver (the contract) ; red = delivers after 3 rechecks
 *   E3  (leg 3) the same over a REST WebSocket subscription
 *   F   (leg 4, control) `alter_user active:false` + one Basic login → the record still exists, so the
 *       re-track keeps it record-backed and the recheck revokes (fail-closed on the inactive user)
 *   G   (leg 4, control) `alter_user role:<noread>` + one Basic login → revoked at the recheck
 *   P   preconditions: authorizeLocal:false in effect (401), the Bearer validator and the override work,
 *       the witness oracle receives
 *
 * Run: npm run test:integration -- "integrationTests/security/getuser-override-memoized-surfaces.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { request as httpRequest } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import WebSocket from 'ws';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/getuser-override-memoized-surfaces');
const RECHECK_MS = 1000;
const TICKS = 3;
const DELIVERY_TIMEOUT_MS = 4000;
const ROLE = 'sqa166_reader';
const NOREAD_ROLE = 'sqa166_noread';
const SECRET = 'open-sesame';

const tablePermission = (read: boolean) => ({
	read,
	insert: false,
	update: false,
	delete: false,
	attribute_permissions: [],
});
const permission = (read: boolean) => ({
	super_user: false,
	data: { tables: { Feed: tablePermission(read), Feed2: tablePermission(read) } },
});

const b64 = (claims: Record<string, unknown>) => Buffer.from(JSON.stringify(claims)).toString('base64url');
/** The opaque MQTT / Basic password the override accepts. */
const token = (role: string, secret = SECRET) => 'sqa166:' + b64({ role, secret });
/** The Bearer token the fixture's validator claims (it names the user; the override supplies the role). */
const bearer = (username: string, role: string, secret = SECRET) => 'sqa166bv.' + b64({ username, role, secret });
const basicHeader = (username: string) => `Basic ${Buffer.from(`${username}:${token(ROLE)}`).toString('base64')}`;

function connect(url: string, opts: IClientOptions): Promise<MqttClient> {
	return new Promise((resolveP, reject) => {
		const client = mqtt.connect(url, {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 8000,
			clean: true,
			clientId: `sqa166-${randomUUID().slice(0, 8)}`,
			...opts,
		});
		const onError = (err: Error) => {
			client.removeListener('connect', onConnect);
			client.end(true);
			reject(err);
		};
		const onConnect = () => {
			client.removeListener('error', onError);
			client.on('error', () => {});
			resolveP(client);
		};
		client.once('error', onError);
		client.once('connect', onConnect);
	});
}

/** SUBACK reason code for one topic filter, read from the broker's packet on rejection (D-238). */
function subscribe(client: MqttClient, topic: string): Promise<number> {
	return new Promise((resolveP, reject) => {
		client.subscribe(topic, { qos: 1 }, (err, granted) => {
			const packetGranted = (err as any)?.packet?.granted;
			if (Array.isArray(packetGranted)) return resolveP(Number(packetGranted[0]));
			if (err) return reject(err);
			const g: any = granted?.[0];
			resolveP(typeof g === 'number' ? g : (g?.reasonCode ?? g?.qos));
		});
	});
}

interface Observer {
	payloads: string[];
	stop: () => void;
}

function collect(client: MqttClient): Observer {
	const payloads: string[] = [];
	const handler = (_topic: string, payload: Buffer) => payloads.push(payload.toString());
	client.on('message', handler);
	return { payloads, stop: () => client.removeListener('message', handler) };
}

function endQuiet(client: MqttClient | undefined): Promise<void> {
	return new Promise((resolveP) => {
		if (!client) return resolveP();
		client.end(true, {}, () => resolveP());
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = DELIVERY_TIMEOUT_MS): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(50);
	}
	return predicate();
}

interface Stream extends Observer {
	status: () => number;
	ended: () => boolean;
	close: () => void;
}

/** An SSE collection subscription; `payloads` holds every `data:` line so a published value can be looked up. */
function openSse(httpURL: string, path: string, authorization: string): Stream {
	const url = new URL(httpURL);
	const payloads: string[] = [];
	let ended = false;
	let status = 0;
	const req = httpRequest(
		{
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port,
			method: 'GET',
			path,
			headers: { Accept: 'text/event-stream', Authorization: authorization },
		},
		(res) => {
			status = res.statusCode ?? 0;
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => {
				for (const line of chunk.split('\n')) if (line.startsWith('data:')) payloads.push(line.slice(5).trim());
			});
			res.on('end', () => (ended = true));
			res.on('close', () => (ended = true));
		}
	);
	req.on('error', () => (ended = true));
	req.end();
	return { payloads, stop: () => {}, status: () => status, ended: () => ended, close: () => req.destroy() };
}

/** A REST WebSocket collection subscription; resolves once open (or failed) with the frames it records. */
function openWs(httpURL: string, path: string, authorization: string): Promise<Stream & { opened: boolean }> {
	const wsURL = httpURL.replace(/^http/, 'ws') + path;
	const payloads: string[] = [];
	let ended = false;
	let status = 0;
	const ws = new WebSocket(wsURL, { headers: { Authorization: authorization }, rejectUnauthorized: false });
	ws.on('message', (d: Buffer) => payloads.push(d.toString()));
	ws.on('close', () => (ended = true));
	ws.on('error', () => {});
	ws.on('unexpected-response', (_req: any, res: any) => (status = res.statusCode ?? 0));
	const stream = {
		payloads,
		stop: () => {},
		status: () => status,
		ended: () => ended,
		close: () => {
			try {
				ws.terminate();
			} catch {
				/* ignore */
			}
		},
		opened: false,
	};
	return new Promise((resolveP) => {
		const timer = setTimeout(() => resolveP(stream), 8000);
		ws.once('open', () => {
			clearTimeout(timer);
			stream.opened = true;
			status = 101;
			resolveP(stream);
		});
		ws.once('error', () => {
			clearTimeout(timer);
			resolveP(stream);
		});
		ws.once('close', () => {
			clearTimeout(timer);
			resolveP(stream);
		});
	});
}

suite(
	'SQA-166: a memoized override user after drop_user / deactivate / role move — Bearer re-track, SSE and WS surfaces (PR #4071)',
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let mqttURL = '';
		let seq = 0;
		const clients = new Set<MqttClient>();
		const streams = new Set<Stream>();
		let witness: Observer;

		const op = (body: Record<string, unknown>) => client.req().send(body).expect(200);
		const publish = async (table: 'Feed' | 'Feed2', label: string): Promise<string> => {
			const value = `${table}-${label}-${seq++}-${randomUUID().slice(0, 8)}`;
			await op({ operation: 'insert', database: 'data', table, records: [{ id: randomUUID(), value }] });
			return value;
		};
		const delivered = (obs: { payloads: string[] }, value: string) => obs.payloads.some((p) => p.includes(value));

		const addMemoUser = (username: string) =>
			op({ operation: 'add_user', username, password: `unused-${randomUUID()}`, role: ROLE, active: true });

		async function openSubscriber(username: string, password: string, topic = 'Feed/#') {
			const c = await connect(mqttURL, { username, password });
			clients.add(c);
			const code = await subscribe(c, topic);
			ok(code < 128, `precondition: ${username} must be granted ${topic}, got SUBACK ${code}`);
			return { client: c, obs: collect(c) };
		}

		/** Publishes to `table` after `TICKS` recheck intervals; the witness must receive, returns whether `obs` did. */
		async function receivesAfterTicks(obs: { payloads: string[] }, table: 'Feed' | 'Feed2', label: string) {
			await sleep(TICKS * RECHECK_MS + 200);
			const value = await publish(table, label);
			ok(await waitFor(() => delivered(witness, value)), `oracle: the witness stopped receiving (${label})`);
			await sleep(700);
			return delivered(obs, value);
		}

		/** One HTTP GET through the override with the given Authorization header; returns the status. */
		async function httpLogin(authorization: string): Promise<number> {
			const res = await fetch(`${ctx.harper.httpURL}/Feed/`, { headers: { authorization } });
			await res.text();
			return res.status;
		}

		async function memoized(username: string): Promise<boolean> {
			const res = await client.reqRest(`/MemoState/?username=${username}`);
			strictEqual(res.status, 200, `MemoState probe: ${res.status} ${JSON.stringify(res.body)}`);
			return res.body.memoized === true;
		}

		/** Subscribes `topic` on `c` after the change: refused (>=128), or granted but ended within TICKS, or kept. */
		async function subscribeOutcome(c: MqttClient, topic: 'Feed2/#', label: string): Promise<string> {
			if (!c.connected) return 'connection-closed';
			let code: number;
			try {
				code = await subscribe(c, topic);
			} catch (err: any) {
				return `subscribe-error:${err?.message}`;
			}
			if (code >= 128) return `refused:${code}`;
			const obs = collect(c);
			const immediate = await publish('Feed2', `${label}-immediate`);
			const deliveredImmediately = await waitFor(() => delivered(obs, immediate));
			const kept = await receivesAfterTicks(obs, 'Feed2', `${label}-after-ticks`);
			obs.stop();
			return `granted:${code},immediate:${deliveredImmediately},after-${TICKS}-ticks:${kept}`;
		}

		/** Opens a held MQTT subscription for a fresh record-backed memo user and proves it receives. */
		async function heldSubscriber(username: string, label: string) {
			await addMemoUser(username);
			const held = await openSubscriber(username, token(ROLE));
			const before = await publish('Feed', `${label}-before`);
			ok(
				await waitFor(() => delivered(held.obs, before)),
				`positive control: ${username} never received while authorized`
			);
			return held;
		}

		/** Waits for a stream to be established and prove it receives (the live positive control for E arms). */
		async function streamReceives(stream: Stream, label: string): Promise<boolean> {
			const value = await publish('Feed', label);
			ok(await waitFor(() => delivered(witness, value)), `oracle: the witness stopped receiving (${label})`);
			return waitFor(() => delivered(stream, value));
		}

		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, {
				config: { authentication: { authorizeLocal: false } },
				env: {
					AUTHENTICATION_AUTHORIZELOCAL: 'false',
					HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS: String(RECHECK_MS),
				},
			});
			client = createApiClient(ctx.harper);
			mqttURL = `${ctx.harper.httpURL.replace(/^http/, 'ws')}/mqtt`;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					const probe = await client.reqRest('/Feed/').timeout(3_000);
					if (probe.status !== 404) break;
				} catch {
					/* not ready */
				}
				await sleep(200);
			}
			await op({ operation: 'add_role', role: ROLE, permission: permission(true) });
			await op({ operation: 'add_role', role: NOREAD_ROLE, permission: permission(false) });
			await op({
				operation: 'add_user',
				username: 'sqa166_witness',
				password: 'Witness-pw-166!',
				role: ROLE,
				active: true,
			});
			const w = await openSubscriber('sqa166_witness', 'Witness-pw-166!');
			const code2 = await subscribe(w.client, 'Feed2/#');
			ok(code2 < 128, `precondition: the witness must be granted Feed2/#, got SUBACK ${code2}`);
			witness = w.obs;
			const v1 = await publish('Feed', 'witness-warmup');
			const v2 = await publish('Feed2', 'witness-warmup');
			ok(
				await waitFor(() => delivered(witness, v1) && delivered(witness, v2)),
				'precondition: the record-backed witness never received'
			);
		});

		after(async () => {
			for (const s of streams) s.close();
			for (const c of clients) await endQuiet(c).catch(() => {});
			await teardownHarper(ctx);
		});

		test('P: 401 without credentials; the override memoizes; Basic and Bearer-validator logins through it are 200 while the record exists', async () => {
			const res = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ operation: 'describe_all' }),
			});
			strictEqual(res.status, 401, `authorizeLocal:false not in effect (status ${res.status})`);
			await addMemoUser('sqa166_p');
			strictEqual(await memoized('sqa166_p'), false, 'nothing memoized before the first login');
			const { obs } = await openSubscriber('sqa166_p', token(ROLE));
			strictEqual(await memoized('sqa166_p'), true, 'the override must memoize the admitted principal');
			const value = await publish('Feed', 'p');
			ok(await waitFor(() => delivered(obs, value)), 'the memoized record-backed subscriber never received');
			strictEqual(await httpLogin(basicHeader('sqa166_p')), 200, 'HTTP Basic through the override must be 200');
			strictEqual(
				await httpLogin(`Bearer ${bearer('sqa166_p', ROLE)}`),
				200,
				'the Bearer validator + override must be 200 while the record exists'
			);
			strictEqual(
				await httpLogin(`Bearer ${bearer('sqa166_p', ROLE, 'wrong')}`),
				401,
				'a bad-secret Bearer token must be refused'
			);
			// a Bearer-validator login for a name the override has NOT memoized builds the entry from the claim
			await addMemoUser('sqa166_pb');
			strictEqual(await httpLogin(`Bearer ${bearer('sqa166_pb', ROLE)}`), 200, 'Bearer-first login must be 200');
			strictEqual(await memoized('sqa166_pb'), true, 'the Bearer path must reach the override and memoize');
			obs.stop();
		});

		test('D (leg 2): drop_user, one Bearer-validator login through the override, then SUBSCRIBE on the held connection', async (t) => {
			const { client: c, obs } = await heldSubscriber('sqa166_d', 'd');
			await op({ operation: 'drop_user', username: 'sqa166_d' });
			const status = await httpLogin(`Bearer ${bearer('sqa166_d', ROLE)}`);
			const heldKept = await receivesAfterTicks(obs, 'Feed', 'd-held-after');
			const outcome = await subscribeOutcome(c, 'Feed2/#', 'd-feed2');
			t.diagnostic(
				`D: Bearer login after drop=${status}; held Feed/# kept=${heldKept}; Feed2/# on the held connection: ${outcome}; connected=${c.connected}`
			);
			// 200 = the Bearer path re-tracked the memoized object (the head); 401 = it refused the dropped user (a fix that
			// keeps the first tracking makes isCurrentUser see the dropped record). Either way the held connection's next
			// SUBSCRIBE must be refused or end — that is the assertion, not the status.
			ok(
				status === 200 || status === 401,
				`unexpected Bearer-validator login status ${status} after drop_user (expected 200 on the head or 401 under a fix)`
			);
			strictEqual(
				heldKept,
				false,
				`dropped memoized user kept receiving on the held Feed/# subscription after a Bearer login`
			);
			ok(
				!outcome.includes(`after-${TICKS}-ticks:true`),
				`a dropped user's held connection subscribed Feed2/# after one Bearer-validator login through the override and kept receiving (${outcome})`
			);
			obs.stop();
		});

		test('E1 (leg 3, control): an SSE subscription opened BEFORE drop_user by the memoized user ends after it', async (t) => {
			await addMemoUser('sqa166_e1');
			const sse = openSse(ctx.harper.httpURL, '/Feed/', basicHeader('sqa166_e1'));
			streams.add(sse);
			await sleep(500);
			ok(
				await streamReceives(sse, 'e1-before'),
				`positive control: the SSE stream never received (status ${sse.status()})`
			);
			await op({ operation: 'drop_user', username: 'sqa166_e1' });
			const kept = await receivesAfterTicks(sse, 'Feed', 'e1-after');
			t.diagnostic(`E1: SSE status=${sse.status()}; kept after drop=${kept}; ended=${sse.ended()}`);
			strictEqual(kept, false, `an SSE subscription opened before drop_user kept delivering (ended=${sse.ended()})`);
		});

		test('E2 (leg 3): drop_user, then an SSE subscription opened by the memoized user (the request is the re-track)', async (t) => {
			await addMemoUser('sqa166_e2');
			const { obs } = await heldSubscriberOrMqttWarm('sqa166_e2');
			await op({ operation: 'drop_user', username: 'sqa166_e2' });
			const sse = openSse(ctx.harper.httpURL, '/Feed/', basicHeader('sqa166_e2'));
			streams.add(sse);
			await sleep(500);
			const immediate = await publish('Feed', 'e2-immediate');
			const deliveredImmediately = await waitFor(() => delivered(sse, immediate));
			const kept = await receivesAfterTicks(sse, 'Feed', 'e2-after');
			const heldKept = delivered(obs, immediate);
			t.diagnostic(
				`E2: SSE after drop status=${sse.status()}; immediate=${deliveredImmediately}; after-${TICKS}-ticks=${kept}; ended=${sse.ended()}; held MQTT got the immediate publish=${heldKept}`
			);
			ok(sse.status() === 200 || sse.status() === 401 || sse.status() === 403, `unexpected SSE status ${sse.status()}`);
			strictEqual(
				kept,
				false,
				`a dropped memoized user's SSE subscription, opened after drop_user, delivered after ${TICKS} rechecks (status ${sse.status()}, immediate=${deliveredImmediately})`
			);
		});

		test('E3 (leg 3): drop_user, then a REST WebSocket subscription opened by the memoized user', async (t) => {
			await addMemoUser('sqa166_e3');
			const { obs } = await heldSubscriberOrMqttWarm('sqa166_e3');
			await op({ operation: 'drop_user', username: 'sqa166_e3' });
			const ws = await openWs(ctx.harper.httpURL, '/Feed/', basicHeader('sqa166_e3'));
			streams.add(ws);
			await sleep(300);
			const immediate = await publish('Feed', 'e3-immediate');
			const deliveredImmediately = await waitFor(() => delivered(ws, immediate));
			const kept = await receivesAfterTicks(ws, 'Feed', 'e3-after');
			const heldKept = delivered(obs, immediate);
			t.diagnostic(
				`E3: WS after drop opened=${ws.opened} status=${ws.status()}; immediate=${deliveredImmediately}; after-${TICKS}-ticks=${kept}; ended=${ws.ended()}; held MQTT got the immediate publish=${heldKept}`
			);
			strictEqual(
				kept,
				false,
				`a dropped memoized user's WebSocket subscription, opened after drop_user, delivered after ${TICKS} rechecks (opened=${ws.opened}, immediate=${deliveredImmediately})`
			);
		});

		test('F (leg 4, control): alter_user active:false, one Basic login, then SUBSCRIBE on the held connection', async (t) => {
			const { client: c, obs } = await heldSubscriber('sqa166_f', 'f');
			await op({ operation: 'alter_user', username: 'sqa166_f', active: false });
			const status = await httpLogin(basicHeader('sqa166_f'));
			const heldKept = await receivesAfterTicks(obs, 'Feed', 'f-held-after');
			const outcome = await subscribeOutcome(c, 'Feed2/#', 'f-feed2');
			t.diagnostic(
				`F: Basic login after deactivate=${status}; held Feed/# kept=${heldKept}; Feed2/# on the held connection: ${outcome}; connected=${c.connected}`
			);
			strictEqual(
				heldKept,
				false,
				`deactivated memoized user kept receiving on the held Feed/# subscription after a Basic login (login=${status})`
			);
			ok(
				!outcome.includes(`after-${TICKS}-ticks:true`),
				`a deactivated user's held connection subscribed Feed2/# after a Basic login and kept receiving (${outcome}; login=${status})`
			);
			obs.stop();
		});

		test('G (leg 4, control): alter_user to a no-read role, one Basic login, then SUBSCRIBE on the held connection', async (t) => {
			const { client: c, obs } = await heldSubscriber('sqa166_g', 'g');
			await op({ operation: 'alter_user', username: 'sqa166_g', role: NOREAD_ROLE });
			const status = await httpLogin(basicHeader('sqa166_g'));
			const heldKept = await receivesAfterTicks(obs, 'Feed', 'g-held-after');
			const outcome = await subscribeOutcome(c, 'Feed2/#', 'g-feed2');
			t.diagnostic(
				`G: Basic login after role move=${status}; held Feed/# kept=${heldKept}; Feed2/# on the held connection: ${outcome}; connected=${c.connected}`
			);
			strictEqual(
				heldKept,
				false,
				`role-moved memoized user kept receiving on the held Feed/# subscription after a Basic login (login=${status})`
			);
			ok(
				!outcome.includes(`after-${TICKS}-ticks:true`),
				`a role-moved user's held connection subscribed Feed2/# after a Basic login and kept receiving (${outcome}; login=${status})`
			);
			obs.stop();
		});

		/** A held MQTT subscription for a user already added, so the principal is memoized record-backed first (as in SQA-165). */
		async function heldSubscriberOrMqttWarm(username: string) {
			const held = await openSubscriber(username, token(ROLE));
			const before = await publish('Feed', `${username}-before`);
			ok(
				await waitFor(() => delivered(held.obs, before)),
				`positive control: ${username} never received while authorized`
			);
			return held;
		}
	}
);
