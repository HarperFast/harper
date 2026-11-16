/**
 * SQA-165 — PR #4071 pre-merge: a record-backed user that a MEMOIZING `server.getUser` override built
 * (one object per username, handed to every later lookup) is dropped with `drop_user`. The documented
 * contract (5.4 release note on the PR head, `subscriptions-of-users-a-getuser-override-builds.md`): a
 * record-backed user "is still revoked when dropped, deactivated or moved to another role".
 *
 * The question: does one HTTP Basic login through the same override, sent after the drop, change what the
 * MQTT side is checked against? `security/auth.ts:302-305` re-tracks the override's object on every HTTP
 * login (`trackUserRecords`, no `trackedProvenance.has` guard), and `trackUserRecords` (`security/user.ts:659-684`)
 * marks it `recordless` when no record has its name at that moment — which, after a drop, is always.
 *
 * Arms (1 s recheck interval, authorizeLocal:false, every principal sends explicit credentials):
 *   P   credential-less ops call -> 401; a token with a bad secret is refused at CONNECT; a memoized
 *       record-backed subscriber receives (the override and the witness oracle work)
 *   A   control: held connection, drop_user, no HTTP -> the Feed/# subscription ends and a SUBSCRIBE to
 *       Feed2/# on the held connection is refused or ends within the recheck window
 *   B   held connection, drop_user, ONE HTTP Basic GET through the override, then SUBSCRIBE Feed2/# on the
 *       held connection -> asserts refused-or-ended (the contract); red = granted and kept
 *   C   drop_user, one HTTP Basic GET, then a FRESH MQTT login with the same credentials -> asserts the new
 *       subscription is refused or ends; C2 is the same without the HTTP request (control)
 *
 * Run: npm run test:integration -- "integrationTests/security/getuser-override-memoized-drop-user.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/getuser-override-memoized-drop-user');
const RECHECK_MS = 1000;
const TICKS = 3;
const DELIVERY_TIMEOUT_MS = 4000;
const ROLE = 'sqa165_reader';
const NOREAD_ROLE = 'sqa165_noread';

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

function token(role: string, secret = 'open-sesame'): string {
	return 'sqa165:' + Buffer.from(JSON.stringify({ role, secret })).toString('base64url');
}

function connect(url: string, opts: IClientOptions): Promise<MqttClient> {
	return new Promise((resolveP, reject) => {
		const client = mqtt.connect(url, {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 8000,
			clean: true,
			clientId: `sqa165-${randomUUID().slice(0, 8)}`,
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

function connectFailure(url: string, opts: IClientOptions): Promise<any> {
	return new Promise((resolveP, reject) => {
		const client = mqtt.connect(url, {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 8000,
			clean: true,
			clientId: `sqa165-${randomUUID().slice(0, 8)}`,
			...opts,
		});
		const timer = setTimeout(() => {
			client.end(true);
			reject(new Error('expected CONNACK failure, timed out'));
		}, 8000);
		client.once('error', (err) => {
			clearTimeout(timer);
			client.end(true);
			resolveP(err);
		});
		client.once('connect', (packet) => {
			clearTimeout(timer);
			client.end(true);
			reject(new Error(`expected CONNACK failure, got success: ${JSON.stringify(packet)}`));
		});
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

function collect(client: MqttClient) {
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
	return false;
}

suite(
	'SQA-165: a memoized override user re-tracked by an HTTP login after drop_user (PR #4071)',
	(ctx: ContextWithHarper) => {
		let client: ReturnType<typeof createApiClient>;
		let mqttURL = '';
		let seq = 0;
		const clients = new Set<MqttClient>();
		let witness: { payloads: string[]; stop: () => void };

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
		async function receivesAfterTicks(
			obs: { payloads: string[] },
			table: 'Feed' | 'Feed2',
			label: string
		): Promise<boolean> {
			await sleep(TICKS * RECHECK_MS + 200);
			const value = await publish(table, label);
			ok(await waitFor(() => delivered(witness, value)), `oracle: the witness stopped receiving (${label})`);
			await sleep(700);
			return delivered(obs, value);
		}

		/** One HTTP Basic GET through the override; returns the status so an arm can assert the re-track happened. */
		async function httpLogin(username: string): Promise<number> {
			const res = await fetch(`${ctx.harper.httpURL}/Feed/`, {
				headers: { authorization: `Basic ${Buffer.from(`${username}:${token(ROLE)}`).toString('base64')}` },
			});
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
				username: 'sqa165_witness',
				password: 'Witness-pw-165!',
				role: ROLE,
				active: true,
			});
			const w = await openSubscriber('sqa165_witness', 'Witness-pw-165!');
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
			for (const c of clients) await endQuiet(c).catch(() => {});
			await teardownHarper(ctx);
		});

		test('P: credential-less ops call is 401; a bad-secret token is refused; a memoized record-backed subscriber receives', async () => {
			const res = await fetch(ctx.harper.operationsAPIURL, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ operation: 'describe_all' }),
			});
			strictEqual(res.status, 401, `authorizeLocal:false not in effect (status ${res.status})`);
			await addMemoUser('sqa165_p');
			const refused = await connectFailure(mqttURL, { username: 'sqa165_p', password: token(ROLE, 'wrong') });
			ok(refused, 'a token with a bad secret must be refused at CONNECT');
			strictEqual(await memoized('sqa165_p'), false, 'a refused login must not memoize a principal');
			const { obs } = await openSubscriber('sqa165_p', token(ROLE));
			strictEqual(await memoized('sqa165_p'), true, 'the override must memoize the admitted principal');
			const value = await publish('Feed', 'p');
			ok(await waitFor(() => delivered(obs, value)), 'the memoized record-backed subscriber never received');
			strictEqual(
				await httpLogin('sqa165_p'),
				200,
				'an HTTP Basic login through the override must be admitted while the record exists'
			);
			obs.stop();
		});

		test('A (control): drop_user with no HTTP login ends the held subscription and refuses a new one', async (t) => {
			await addMemoUser('sqa165_a');
			const { client: c, obs } = await openSubscriber('sqa165_a', token(ROLE));
			const before = await publish('Feed', 'a-before');
			ok(await waitFor(() => delivered(obs, before)), 'positive control: A never received while authorized');
			await op({ operation: 'drop_user', username: 'sqa165_a' });
			const kept = await receivesAfterTicks(obs, 'Feed', 'a-after');
			strictEqual(
				kept,
				false,
				`dropped memoized user kept receiving on the held Feed/# subscription (connected=${c.connected})`
			);
			const outcome = await subscribeOutcome(c, 'Feed2/#', 'a-feed2');
			t.diagnostic(`A: held Feed/# kept=${kept}; Feed2/# on the held connection: ${outcome}; connected=${c.connected}`);
			ok(
				!outcome.includes('after-3-ticks:true'),
				`a dropped user's held connection subscribed Feed2/# and kept receiving (${outcome})`
			);
			obs.stop();
		});

		test('B: drop_user, one HTTP login through the override, then SUBSCRIBE on the held connection', async (t) => {
			await addMemoUser('sqa165_b');
			const { client: c, obs } = await openSubscriber('sqa165_b', token(ROLE));
			const before = await publish('Feed', 'b-before');
			ok(await waitFor(() => delivered(obs, before)), 'positive control: B never received while authorized');
			await op({ operation: 'drop_user', username: 'sqa165_b' });
			const status = await httpLogin('sqa165_b');
			strictEqual(
				status,
				200,
				`precondition: the HTTP re-track did not happen (override login answered ${status} after drop_user)`
			);
			const heldKept = await receivesAfterTicks(obs, 'Feed', 'b-held-after');
			const outcome = await subscribeOutcome(c, 'Feed2/#', 'b-feed2');
			t.diagnostic(
				`B: HTTP after drop=${status}; held Feed/# kept=${heldKept}; Feed2/# on the held connection: ${outcome}; connected=${c.connected}`
			);
			strictEqual(
				heldKept,
				false,
				`dropped memoized user kept receiving on the held Feed/# subscription after an HTTP login (connected=${c.connected})`
			);
			ok(
				!outcome.includes('after-3-ticks:true'),
				`a dropped user's held connection subscribed Feed2/# after one HTTP login through the override and kept receiving (${outcome}; held Feed/# kept=${heldKept})`
			);
			obs.stop();
		});

		test('C: drop_user, one HTTP login, then a fresh MQTT login with the same credentials', async (t) => {
			await addMemoUser('sqa165_c');
			const { client: first, obs: firstObs } = await openSubscriber('sqa165_c', token(ROLE));
			const before = await publish('Feed', 'c-before');
			ok(await waitFor(() => delivered(firstObs, before)), 'positive control: C never received while authorized');
			firstObs.stop();
			await op({ operation: 'drop_user', username: 'sqa165_c' });
			const status = await httpLogin('sqa165_c');
			strictEqual(
				status,
				200,
				`precondition: the HTTP re-track did not happen (override login answered ${status} after drop_user)`
			);
			let fresh: MqttClient;
			try {
				fresh = await connect(mqttURL, { username: 'sqa165_c', password: token(ROLE) });
			} catch (err: any) {
				// refused at CONNECT is the contract holding
				t.diagnostic(`C: HTTP after drop=${status}; fresh CONNECT refused: ${err?.message}`);
				return;
			}
			clients.add(fresh);
			const outcome = await subscribeOutcome(fresh, 'Feed2/#', 'c-fresh');
			t.diagnostic(`C: HTTP after drop=${status}; fresh CONNECT admitted; Feed2/#: ${outcome}`);
			ok(
				!outcome.includes('after-3-ticks:true'),
				`a fresh MQTT login of a dropped user, after one HTTP login through the override, subscribed and kept receiving (${outcome}; first connection connected=${first.connected})`
			);
		});

		test('C2 (control): drop_user then a fresh MQTT login with no HTTP login in between', async (t) => {
			await addMemoUser('sqa165_c2');
			const { obs: firstObs } = await openSubscriber('sqa165_c2', token(ROLE));
			const before = await publish('Feed', 'c2-before');
			ok(await waitFor(() => delivered(firstObs, before)), 'positive control: C2 never received while authorized');
			firstObs.stop();
			await op({ operation: 'drop_user', username: 'sqa165_c2' });
			let fresh: MqttClient;
			try {
				fresh = await connect(mqttURL, { username: 'sqa165_c2', password: token(ROLE) });
			} catch (err: any) {
				t.diagnostic(`C2: fresh CONNECT refused: ${err?.message}`);
				return;
			}
			clients.add(fresh);
			const outcome = await subscribeOutcome(fresh, 'Feed2/#', 'c2-fresh');
			t.diagnostic(`C2: fresh CONNECT admitted; Feed2/#: ${outcome}`);
			ok(
				!outcome.includes('after-3-ticks:true'),
				`a fresh MQTT login of a dropped memoized user (no HTTP login) subscribed and kept receiving (${outcome})`
			);
		});
	}
);
