/**
 * SQA-157 / SQA-183 — PR #4071 (fixes #3310): a `server.getUser` override principal with no hdb_user record
 * (a "recordless" principal) is kept through live-subscription rechecks. Which changes end its MQTT
 * subscription, and do the documented revocation routes (allowRead, authExpiresAt) hold?
 *
 * Contract under test (docs/reference/database/schema.md, "Live subscriptions are periodically
 * re-authorized"): a recordless user "is not reloaded: the recheck runs allowRead against the user it
 * admitted, and the subscription ends when the connection closes, or at the user's authExpiresAt";
 * record-backed users "are still revoked when they are dropped, deactivated or moved to another role"
 * (release note subscriptions-of-users-a-getuser-override-builds.md). So an edit or drop of the hdb_role
 * an override copied its permission from reaches the next login only (harper#4061), never the open stream.
 *
 * Arms (1 s recheck interval, authorizeLocal:false, every principal sends explicit credentials):
 *   A  recordless subscriber keeps receiving across 4 recheck intervals (the PR's fix; red on base)
 *   B  record-backed password user: alter_role (read -> false) on its role ends its subscription (control)
 *   C  recordless subscriber whose token names an hdb_role: alter_role (read -> false) on that role keeps
 *      the open subscription (not reloaded), while a fresh login with the same token is refused
 *   D  recordless subscriber whose token names an hdb_role: drop_role on that role keeps the open
 *      subscription, while a fresh login with the same token is refused at CONNECT
 *   E  recordless subscriber on GatedFeed: a revocation row read by allowRead ends it (documented route)
 *   F  recordless subscriber with authExpiresAt 3 s ahead ends by the expiry timer (documented route)
 *   G  a record created later under the recordless name does not change it (PR body: by design)
 *   P  preconditions: credential-less ops call -> 401; a token naming a no-read role is refused at SUBSCRIBE
 *
 * Run: npm run test:integration -- "integrationTests/security/getuser-override-recordless-principal.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok, notStrictEqual } from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/getuser-override-recordless-principal');
const RECHECK_MS = 1000;
const TICKS = 3;
const DELIVERY_TIMEOUT_MS = 4000;

const feedPermission = (read: boolean) => ({
	super_user: false,
	data: {
		tables: {
			Feed: { read, insert: false, update: false, delete: false, attribute_permissions: [] },
			Gate: { read: false, insert: false, update: false, delete: false, attribute_permissions: [] },
		},
	},
});

function token(role: string, extra: Record<string, unknown> = {}): string {
	return 'sqa157:' + Buffer.from(JSON.stringify({ role, ...extra })).toString('base64url');
}

function connect(url: string, opts: IClientOptions): Promise<MqttClient> {
	return new Promise((resolveP, reject) => {
		const client = mqtt.connect(url, {
			protocolVersion: 5,
			reconnectPeriod: 0,
			connectTimeout: 8000,
			clean: true,
			clientId: `sqa157-${randomUUID().slice(0, 8)}`,
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
			clientId: `sqa157-${randomUUID().slice(0, 8)}`,
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

suite('SQA-157: revocation of a recordless server.getUser principal (PR #4071)', (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let mqttURL = '';
	let seq = 0;
	const clients = new Set<MqttClient>();
	let witness: { payloads: string[]; stop: () => void };

	const op = (body: Record<string, unknown>) => client.req().send(body).expect(200);
	const addRole = (role: string, read = true) => op({ operation: 'add_role', role, permission: feedPermission(read) });
	const publish = async (label: string): Promise<string> => {
		const value = `${label}-${seq++}-${randomUUID().slice(0, 8)}`;
		await op({ operation: 'insert', database: 'data', table: 'Feed', records: [{ id: randomUUID(), value }] });
		return value;
	};
	const delivered = (obs: { payloads: string[] }, value: string) => obs.payloads.some((p) => p.includes(value));
	const roleIdOf = async (role: string): Promise<string> => {
		const roles = await op({ operation: 'list_roles' });
		const id = roles.body.find((r: any) => r.role === role)?.id;
		ok(id, `list_roles must show ${role}`);
		return id;
	};
	const alterRole = async (role: string, read: boolean) =>
		op({ operation: 'alter_role', id: await roleIdOf(role), role, permission: feedPermission(read) });

	async function openSubscriber(username: string, password: string, topic = 'Feed/#') {
		const c = await connect(mqttURL, { username, password });
		clients.add(c);
		const code = await subscribe(c, topic);
		ok(code < 128, `precondition: ${username} must be granted ${topic}, got SUBACK ${code}`);
		return { client: c, obs: collect(c) };
	}

	/** Publishes after `TICKS` recheck intervals; the Feed witness must receive, returns whether `obs` did. */
	async function receivesAfterTicks(obs: { payloads: string[] }, label: string): Promise<boolean> {
		await sleep(TICKS * RECHECK_MS + 200);
		const value = await publish(label);
		ok(await waitFor(() => delivered(witness, value)), `oracle: the witness stopped receiving (${label})`);
		await sleep(700);
		return delivered(obs, value);
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
		for (const role of ['witness', 'a', 'b', 'c', 'd', 'e', 'e2', 'f', 'g']) await addRole(`sqa157_${role}`);
		await addRole('sqa157_noread', false);
		await op({
			operation: 'add_user',
			username: 'sqa157_witness',
			password: 'Witness-pw-157!',
			role: 'sqa157_witness',
			active: true,
		});
		const w = await openSubscriber('sqa157_witness', 'Witness-pw-157!');
		witness = w.obs;
		const value = await publish('witness-warmup');
		ok(await waitFor(() => delivered(witness, value)), 'precondition: the record-backed witness never received');
	});

	after(async () => {
		for (const c of clients) await endQuiet(c).catch(() => {});
		await teardownHarper(ctx);
	});

	test('P: credential-less operations call is 401; a token naming a no-read role is refused at SUBSCRIBE', async () => {
		const res = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ operation: 'describe_all' }),
		});
		strictEqual(res.status, 401, `authorizeLocal:false not in effect (status ${res.status})`);
		const c = await connect(mqttURL, { username: 'sqa157_p', password: token('sqa157_noread') });
		clients.add(c);
		const code = await subscribe(c, 'Feed/#');
		ok(code >= 128, `a token naming a no-read role was granted Feed/# (SUBACK ${code})`);
		const unknown = await connectFailure(mqttURL, { username: 'sqa157_p2', password: token('sqa157_missing') });
		ok(unknown, 'a token naming a missing role must be refused at CONNECT');
	});

	test('A: a recordless subscriber keeps receiving across recheck intervals', async () => {
		const { client: c, obs } = await openSubscriber('sqa157_a', token('sqa157_a'));
		for (let interval = 0; interval <= 4; interval++) {
			if (interval > 0) await sleep(RECHECK_MS + 100);
			const value = await publish(`a-${interval}`);
			ok(
				await waitFor(() => delivered(obs, value)),
				`no delivery after ${interval} recheck interval(s) (connected=${c.connected})`
			);
		}
		obs.stop();
	});

	test('B (control): alter_role removing read ends a record-backed password subscriber', async () => {
		await op({ operation: 'add_user', username: 'sqa157_b', password: 'B-pw-157!', role: 'sqa157_b', active: true });
		const { client: c, obs } = await openSubscriber('sqa157_b', 'B-pw-157!');
		const before = await publish('b-before');
		ok(await waitFor(() => delivered(obs, before)), 'positive control: B never received while authorized');
		await alterRole('sqa157_b', false);
		strictEqual(
			await receivesAfterTicks(obs, 'b-after'),
			false,
			`record-backed subscriber kept receiving after alter_role (connected=${c.connected})`
		);
		obs.stop();
	});

	test('C: alter_role removing read on the hdb_role a recordless token names reaches the next login, not the open subscription', async () => {
		const { client: c, obs } = await openSubscriber('sqa157_c', token('sqa157_c'));
		const before = await publish('c-before');
		ok(await waitFor(() => delivered(obs, before)), 'positive control: C never received while authorized');
		await alterRole('sqa157_c', false);
		const kept = await receivesAfterTicks(obs, 'c-after');
		// isolation: the same token at a fresh login now resolves the edited role and is refused
		const fresh = await connect(mqttURL, { username: 'sqa157_c_fresh', password: token('sqa157_c') });
		clients.add(fresh);
		const freshCode = await subscribe(fresh, 'Feed/#');
		ok(freshCode >= 128, `a fresh login with the same token was granted Feed/# after alter_role (SUBACK ${freshCode})`);
		strictEqual(
			kept,
			true,
			`alter_role on its role ended a recordless subscriber (connected=${c.connected}); documented: it is not reloaded and ends at close or authExpiresAt`
		);
		obs.stop();
	});

	test('D: drop_role on the hdb_role a recordless token names reaches the next login, not the open subscription', async () => {
		const { client: c, obs } = await openSubscriber('sqa157_d', token('sqa157_d'));
		const before = await publish('d-before');
		ok(await waitFor(() => delivered(obs, before)), 'positive control: D never received while authorized');
		await op({ operation: 'drop_role', id: await roleIdOf('sqa157_d') });
		const kept = await receivesAfterTicks(obs, 'd-after');
		const refused = await connectFailure(mqttURL, { username: 'sqa157_d_fresh', password: token('sqa157_d') });
		ok(refused, 'a fresh login with the same token must be refused once its role is dropped');
		strictEqual(
			kept,
			true,
			`drop_role on its role ended a recordless subscriber (connected=${c.connected}); documented: it is not reloaded and ends at close or authExpiresAt`
		);
		obs.stop();
	});

	test('E: a revocation row read by a composed allowRead ends a recordless GatedFeed subscriber', async () => {
		const { client: c, obs } = await openSubscriber('sqa157_e', token('sqa157_e'), 'GatedFeed/#');
		const { obs: peer } = await openSubscriber('sqa157_e2', token('sqa157_e2'), 'GatedFeed/#');
		const before = await publish('e-before');
		ok(await waitFor(() => delivered(obs, before)), 'positive control: E never received on GatedFeed while authorized');
		ok(await waitFor(() => delivered(peer, before)), 'positive control: the GatedFeed peer never received');
		await op({ operation: 'insert', database: 'data', table: 'Gate', records: [{ id: 'sqa157_e', revoked: true }] });
		const kept = await receivesAfterTicks(obs, 'e-after');
		strictEqual(
			kept,
			false,
			`the revocation row did not end the recordless GatedFeed subscriber (connected=${c.connected})`
		);
		await sleep(300);
		ok(
			peer.payloads.some((p) => p.includes('e-after')),
			`the unrevoked GatedFeed peer stopped receiving (received ${peer.payloads.length}, last ${peer.payloads.at(-1) ?? 'none'})`
		);
		obs.stop();
		peer.stop();
	});

	test('F: authExpiresAt set by the override ends a recordless subscriber by the expiry timer', async () => {
		const exp = Math.floor(Date.now() / 1000) + 3;
		const { client: c, obs } = await openSubscriber('sqa157_f', token('sqa157_f', { exp }));
		const before = await publish('f-before');
		ok(await waitFor(() => delivered(obs, before)), 'positive control: F never received while unexpired');
		await sleep((exp + 2) * 1000 - Date.now());
		const value = await publish('f-after');
		ok(await waitFor(() => delivered(witness, value)), 'oracle: the witness stopped receiving (f-after)');
		await sleep(700);
		strictEqual(
			delivered(obs, value),
			false,
			`recordless subscriber kept receiving past authExpiresAt (connected=${c.connected})`
		);
		obs.stop();
	});

	test('G: an hdb_user record created later under the recordless name does not change it (by design)', async () => {
		const { client: c, obs } = await openSubscriber('sqa157_g', token('sqa157_g'));
		const before = await publish('g-before');
		ok(await waitFor(() => delivered(obs, before)), 'positive control: G never received while authorized');
		await op({
			operation: 'add_user',
			username: 'sqa157_g',
			password: 'G-pw-157!',
			role: 'sqa157_noread',
			active: true,
		});
		const keptAfterAdd = await receivesAfterTicks(obs, 'g-after-add');
		await op({ operation: 'drop_user', username: 'sqa157_g' });
		const keptAfterDrop = await receivesAfterTicks(obs, 'g-after-drop');
		notStrictEqual(obs.payloads.length, 0);
		strictEqual(
			`${keptAfterAdd}/${keptAfterDrop}`,
			'true/true',
			`recordless subscriber changed by a later record (after add_user: ${keptAfterAdd}, after drop_user: ${keptAfterDrop}, connected=${c.connected})`
		);
		obs.stop();
	});
});
