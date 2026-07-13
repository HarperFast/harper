/**
 * Continuous re-authorization for live subscriptions (HarperFast/harper#1414).
 *
 * Subscribe-time authorization is a point-in-time check — once an SSE/WS/MQTT stream is open it
 * keeps delivering even if the principal later loses access or its bearer token expires. These
 * tests open a live subscription and assert delivery STOPS after:
 *   1. the user's permission is revoked (drop_user) — event-driven via the user-change broadcast,
 *   2. an in-place role-permission edit (alter_role) removes the read grant — same event-driven path
 *      but revokes via the ROLE rather than the user record, and
 *   3. the bearer token the subscription was opened with expires — caught by the interval sweep.
 *
 * Each trigger is exercised on at least two transports (SSE/WS/MQTT) so the fix is verified at the
 * shared re-auth registry, not one protocol's wiring:
 *   drop_user     -> SSE, MQTT
 *   alter_role    -> WS,  MQTT
 *   token expiry  -> SSE, WS
 * A persistent oracle subscription (never revoked) runs for the whole suite and is checked after
 * every new-trigger test to rule out a global delivery stall masquerading as a targeted revocation.
 *
 * Re-authorization is table/RBAC-level (matching how the subscription was granted); there is no
 * per-record evaluation.
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import WebSocket from 'ws';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/subscription-revocation');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const ROLE = 'subrevoke_role';
// A dedicated role for the alter_role tests, which strip its read grant in place and restore it —
// keeping it separate from ROLE avoids any cross-test ordering dependency on the other users' access.
const ROLE_ALTER = 'subrevoke_role_alter';
const ALICE = { username: 'subrevoke_alice', password: 'Alice-pw-1414!' };
const BOB = { username: 'subrevoke_bob', password: 'Bobby-pw-1414!' };
const CAROL = { username: 'subrevoke_carol', password: 'Carol-pw-1414!' }; // drop_user / MQTT
const DAVE = { username: 'subrevoke_dave', password: 'Davey-pw-1414!' }; // token expiry / WS
const EVE = { username: 'subrevoke_eve', password: 'Evelyn-pw-1414!' }; // alter_role / WS
const FRANK = { username: 'subrevoke_frank', password: 'Franky-pw-1414!' }; // alter_role / MQTT
const OBS = { username: 'subrevoke_obs', password: 'Observ-pw-1414!' }; // never revoked — global-stall oracle

/** An open SSE stream that records how many record events have arrived. */
interface SseStream {
	count: () => number;
	ended: () => boolean;
	status: () => number;
	close: () => void;
}

// Returns synchronously — Harper flushes SSE headers on the first delivered event, so we must not
// block on the response callback before producing a write. Handlers are attached when the response
// begins; the caller seeds writes after a short settle so the subscription is established first.
function openSse(restURL: string, path: string, headers: Record<string, string>): SseStream {
	const url = new URL(restURL);
	let events = 0;
	let ended = false;
	let status = 0;
	const req = httpRequest(
		{
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port,
			method: 'GET',
			path,
			headers: { Accept: 'text/event-stream', ...headers },
		},
		(res) => {
			status = res.statusCode ?? 0;
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => {
				// Count SSE data lines carrying a record payload (one per delivered event).
				for (const line of chunk.split('\n')) {
					if (line.startsWith('data:') && line.slice(5).trim().length > 0) events++;
				}
			});
			res.on('end', () => (ended = true));
			res.on('close', () => (ended = true));
		}
	);
	req.on('error', () => (ended = true));
	req.end();
	return { count: () => events, ended: () => ended, status: () => status, close: () => req.destroy() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 6000, intervalMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleepMs(intervalMs);
	}
	return predicate();
}

/** An open WS subscription that records incoming frames. */
interface WsSub {
	frames: string[];
	closed: boolean;
	terminate: () => void;
}

function openWs(wsBase: string, path: string, authHeader: string): Promise<WsSub> {
	const frames: string[] = [];
	const ws = new WebSocket(`${wsBase}${path}`, { headers: { Authorization: authHeader }, rejectUnauthorized: false });
	const sub: WsSub = {
		frames,
		closed: false,
		terminate: () => {
			try {
				ws.terminate();
			} catch {
				/* ignore */
			}
		},
	};
	ws.on('message', (d: Buffer) => frames.push(d.toString()));
	ws.on('close', () => (sub.closed = true));
	ws.on('error', () => {});
	return new Promise<WsSub>((resolveP) => {
		const timer = setTimeout(() => {
			ws.off('open', onOpenOrError);
			ws.off('error', onOpenOrError);
			resolveP(sub);
		}, 8000);
		const onOpenOrError = () => {
			clearTimeout(timer);
			resolveP(sub);
		};
		ws.once('open', onOpenOrError);
		ws.once('error', onOpenOrError);
	});
}

function mqttConnect(url: string, user: { username: string; password: string }, clientId: string): Promise<MqttClient> {
	const opts: IClientOptions = {
		protocolVersion: 5,
		reconnectPeriod: 0,
		connectTimeout: 8000,
		clean: true,
		rejectUnauthorized: false, // parity with openWs: tolerate self-signed TLS if the harness serves wss
		...user,
		clientId,
	};
	return new Promise((resolveP, reject) => {
		const mqttClient = mqtt.connect(url, opts);
		const onError = (err: Error) => {
			mqttClient.removeListener('connect', onConnect);
			mqttClient.end(true);
			reject(err);
		};
		const onConnect = () => {
			mqttClient.removeListener('error', onError);
			mqttClient.on('error', () => {});
			resolveP(mqttClient);
		};
		mqttClient.once('error', onError);
		mqttClient.once('connect', onConnect);
	});
}

function endQuiet(mqttClient: MqttClient | undefined): Promise<void> {
	return new Promise((resolveP) => {
		if (!mqttClient) return resolveP();
		mqttClient.end(true, {}, () => resolveP());
	});
}

suite('Live subscription re-authorization (#1414)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let restURL = '';
	let wsBase = '';
	let mqttURL = '';
	let seq = 0;
	let obsStream: SseStream;
	const wsSubs = new Set<WsSub>();
	const mqttClients = new Set<MqttClient>();

	const insert = (record: Record<string, unknown>) =>
		client
			.req()
			.send({ operation: 'insert', schema: 'data', table: 'Owned', records: [record] })
			.expect(200);

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {},
			env: {
				AUTHENTICATION_AUTHORIZELOCAL: 'false',
				// Sweep often so the token-expiry path (not event-signaled) is observable in-test.
				HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS: '1000',
			},
		});
		client = createApiClient(ctx.harper);
		restURL = ctx.harper.httpURL;
		wsBase = restURL.replace(/^http/, 'ws'); // http→ws, https→wss
		mqttURL = `${wsBase}/mqtt`;

		// Wait for the route.
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				const probe = await client.reqRest('/Owned/').timeout(3_000);
				if (probe.status !== 404) break;
			} catch {
				/* not ready */
			}
			await sleep(200);
		}

		const readPermission = (read: boolean) => ({
			super_user: false,
			data: { tables: { Owned: { read, insert: false, update: false, delete: false, attribute_permissions: [] } } },
		});
		await client
			.req()
			.send({ operation: 'add_role', role: ROLE, permission: readPermission(true) })
			.expect(200);
		await client
			.req()
			.send({ operation: 'add_role', role: ROLE_ALTER, permission: readPermission(true) })
			.expect(200);
		for (const u of [ALICE, BOB, CAROL]) {
			await client
				.req()
				.send({ operation: 'add_user', role: ROLE, username: u.username, password: u.password, active: true })
				.expect(200);
		}
		for (const u of [DAVE, OBS]) {
			await client
				.req()
				.send({ operation: 'add_user', role: ROLE, username: u.username, password: u.password, active: true })
				.expect(200);
		}
		for (const u of [EVE, FRANK]) {
			await client
				.req()
				.send({ operation: 'add_user', role: ROLE_ALTER, username: u.username, password: u.password, active: true })
				.expect(200);
		}

		// Persistent oracle — opened once here, stays live across every trigger test. Since it is
		// never revoked, continued delivery after each trigger proves that trigger targeted only the
		// revoked principal rather than stalling delivery for everyone.
		const obsHeaders = { Authorization: 'Basic ' + Buffer.from(`${OBS.username}:${OBS.password}`).toString('base64') };
		obsStream = openSse(restURL, '/Owned/', obsHeaders);
		await sleep(500);
	});

	after(async () => {
		try {
			obsStream?.close();
		} catch {
			/* ignore */
		}
		for (const s of wsSubs) s.terminate();
		for (const c of mqttClients) await endQuiet(c).catch(() => {});
		await teardownHarper(ctx);
	});

	// Checked after every new-trigger test to rule out a global delivery stall.
	async function assertOracleAlive(tag: string): Promise<void> {
		const before = obsStream.count();
		await insert({ id: `r-${seq++}`, value: tag });
		const delivered = await waitFor(() => obsStream.count() > before, 6000);
		ok(delivered, `ORACLE STALL: the always-authorized oracle subscription stopped receiving writes during "${tag}"`);
	}

	test('permission loss (drop_user) terminates an active subscription', async () => {
		const headers = { Authorization: 'Basic ' + Buffer.from(`${ALICE.username}:${ALICE.password}`).toString('base64') };
		const stream = openSse(restURL, '/Owned/', headers);
		try {
			await sleep(800); // let the subscription establish
			// Baseline: a write while authorized is delivered.
			await insert({ id: `r-${seq++}`, value: 'before' });
			await sleep(1000);
			ok(stream.status() === 0 || stream.status() === 200, `unexpected SSE status ${stream.status()}`);
			const afterFirst = stream.count();
			ok(afterFirst >= 1, `expected delivery while authorized, saw ${afterFirst} events`);

			// Revoke access mid-stream. drop_user broadcasts a user-change → immediate re-auth sweep.
			await client.req().send({ operation: 'drop_user', username: ALICE.username }).expect(200);
			await sleep(2000);

			// A write after revocation must NOT be delivered.
			const beforeRevokeProbe = stream.count();
			await insert({ id: `r-${seq++}`, value: 'after-revoke' });
			await sleep(1500);
			strictEqual(
				stream.count(),
				beforeRevokeProbe,
				`subscription kept delivering after drop_user (got ${stream.count() - beforeRevokeProbe} extra events)`
			);
		} finally {
			stream.close();
		}
	});

	test('bearer token expiry terminates an active subscription', async () => {
		// Issue a short-lived operation token for Bob (independent of the dropped Alice).
		const tokenResp = await client.req().send({
			operation: 'create_authentication_tokens',
			username: BOB.username,
			password: BOB.password,
			expires_in: 3,
		});
		strictEqual(tokenResp.status, 200, `token issue failed: ${tokenResp.status} ${tokenResp.text}`);
		const token = tokenResp.body?.operation_token;
		ok(token, 'expected an operation_token');

		const stream = openSse(restURL, '/Owned/', { Authorization: `Bearer ${token}` });
		try {
			await sleep(800); // let the subscription establish
			await insert({ id: `r-${seq++}`, value: 'token-before' });
			await sleep(1000);
			ok(stream.count() >= 1, `expected delivery while token valid, saw ${stream.count()}`);

			// Wait past token expiry (3s) plus a sweep interval (1s).
			await sleep(4000);
			const probe = stream.count();
			await insert({ id: `r-${seq++}`, value: 'token-after' });
			await sleep(1500);
			strictEqual(
				stream.count(),
				probe,
				`subscription kept delivering after token expiry (${stream.count() - probe} extra)`
			);
		} finally {
			stream.close();
		}
	});

	test('permission loss (drop_user) terminates an active MQTT connection', async () => {
		const mqttClient = await mqttConnect(mqttURL, CAROL, 'subrevoke-drop-mqtt');
		mqttClients.add(mqttClient);
		const msgs: string[] = [];
		mqttClient.on('message', (_t, payload) => msgs.push(payload.toString()));
		await new Promise<void>((res, rej) =>
			mqttClient.subscribe('Owned/#', { qos: 1 }, (err) => (err ? rej(err) : res()))
		);

		await insert({ id: `r-${seq++}`, value: 'mqtt-drop-pre' });
		const gotPre = await waitFor(() => msgs.length >= 1, 6000);
		ok(gotPre, 'positive control failed — MQTT subscription never delivered while authorized');

		await client.req().send({ operation: 'drop_user', username: CAROL.username }).expect(200);
		await sleep(2000); // match the SSE drop_user window; give the user-change broadcast / re-auth sweep time to land under CI load

		const preCount = msgs.length;
		await insert({ id: `r-${seq++}`, value: 'mqtt-drop-post' });
		await sleep(1500);
		await assertOracleAlive('mqtt-drop-oracle');
		strictEqual(
			msgs.length,
			preCount,
			`MQTT connection kept delivering after drop_user (connected=${mqttClient.connected})`
		);
	});

	test('alter_role (removing read in place) terminates an active WS subscription', async () => {
		const auth = 'Basic ' + Buffer.from(`${EVE.username}:${EVE.password}`).toString('base64');
		const sub = await openWs(wsBase, '/Owned/', auth);
		wsSubs.add(sub);

		await insert({ id: `r-${seq++}`, value: 'ws-alter-pre' });
		const gotPre = await waitFor(() => sub.frames.length >= 1, 6000);
		ok(gotPre, 'positive control failed — WS subscription never delivered while authorized');

		try {
			await client
				.req()
				.send({
					operation: 'alter_role',
					id: ROLE_ALTER,
					permission: {
						super_user: false,
						data: {
							tables: {
								Owned: { read: false, insert: false, update: false, delete: false, attribute_permissions: [] },
							},
						},
					},
				})
				.expect(200);
			await sleep(2000); // match the SSE drop_user window; give the user-change broadcast / re-auth sweep time to land under CI load

			const preCount = sub.frames.length;
			await insert({ id: `r-${seq++}`, value: 'ws-alter-post' });
			await sleep(1500);
			await assertOracleAlive('ws-alter-oracle');
			strictEqual(
				sub.frames.length,
				preCount,
				`WS subscription kept delivering after alter_role removed read (closed=${sub.closed})`
			);
		} finally {
			// Restore ROLE_ALTER's read grant so it doesn't bleed into the MQTT alter_role test.
			await client
				.req()
				.send({
					operation: 'alter_role',
					id: ROLE_ALTER,
					permission: {
						super_user: false,
						data: {
							tables: { Owned: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] } },
						},
					},
				})
				.catch(() => {});
		}
	});

	test('alter_role (removing read in place) terminates an active MQTT connection', async () => {
		const mqttClient = await mqttConnect(mqttURL, FRANK, 'subrevoke-alter-mqtt');
		mqttClients.add(mqttClient);
		const msgs: string[] = [];
		mqttClient.on('message', (_t, payload) => msgs.push(payload.toString()));
		await new Promise<void>((res, rej) =>
			mqttClient.subscribe('Owned/#', { qos: 1 }, (err) => (err ? rej(err) : res()))
		);

		await insert({ id: `r-${seq++}`, value: 'mqtt-alter-pre' });
		const gotPre = await waitFor(() => msgs.length >= 1, 6000);
		ok(gotPre, 'positive control failed — MQTT subscription never delivered while authorized');

		try {
			await client
				.req()
				.send({
					operation: 'alter_role',
					id: ROLE_ALTER,
					permission: {
						super_user: false,
						data: {
							tables: {
								Owned: { read: false, insert: false, update: false, delete: false, attribute_permissions: [] },
							},
						},
					},
				})
				.expect(200);
			await sleep(2000); // match the SSE drop_user window; give the user-change broadcast / re-auth sweep time to land under CI load

			const preCount = msgs.length;
			await insert({ id: `r-${seq++}`, value: 'mqtt-alter-post' });
			await sleep(1500);
			await assertOracleAlive('mqtt-alter-oracle');
			strictEqual(
				msgs.length,
				preCount,
				`MQTT connection kept delivering after alter_role removed read (connected=${mqttClient.connected})`
			);
		} finally {
			await client
				.req()
				.send({
					operation: 'alter_role',
					id: ROLE_ALTER,
					permission: {
						super_user: false,
						data: {
							tables: { Owned: { read: true, insert: false, update: false, delete: false, attribute_permissions: [] } },
						},
					},
				})
				.catch(() => {});
		}
	});

	test('bearer token expiry terminates an active WS subscription', async () => {
		const tokenResp = await client.req().send({
			operation: 'create_authentication_tokens',
			username: DAVE.username,
			password: DAVE.password,
			expires_in: 3,
		});
		strictEqual(tokenResp.status, 200, `token issue failed: ${tokenResp.status} ${tokenResp.text}`);
		const token = tokenResp.body?.operation_token;
		ok(token, 'expected an operation_token');

		const sub = await openWs(wsBase, '/Owned/', `Bearer ${token}`);
		wsSubs.add(sub);

		await insert({ id: `r-${seq++}`, value: 'ws-token-pre' });
		const gotPre = await waitFor(() => sub.frames.length >= 1, 6000);
		ok(gotPre, 'positive control failed — WS subscription never delivered while token valid');

		// Wait past token expiry (3s) plus a sweep interval (1s).
		await sleep(4200);
		const preCount = sub.frames.length;
		await insert({ id: `r-${seq++}`, value: 'ws-token-post' });
		await sleep(1500);
		await assertOracleAlive('ws-token-oracle');
		strictEqual(
			sub.frames.length,
			preCount,
			`WS subscription kept delivering after bearer token expired (closed=${sub.closed})`
		);
	});
});
