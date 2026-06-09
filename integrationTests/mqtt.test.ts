/**
 * MQTT integration test suite — JWT auth, ACL, durable sessions, QoS, %u,
 * anonymousSubscriber, schema-less retained message tables, SYS_CON monitoring,
 * and high-throughput connect/disconnect (#1188).
 *
 * Deploys the mqtt-full fixture (integrationTests/components/fixtures/mqtt-full)
 * which bundles @harperdb/acl-connect with a connect.json that covers:
 *   - dog/#          group-based pub/sub ACL (dogPublisher / dogSubscriber)
 *   - public/#       anonymousSubscriber: true
 *   - $SYS/#         sysMonitor group subscription
 *   - user-topics/#  %u substitution (implemented in resources.js)
 * plus two Harper tables defined in schema.graphql:
 *   - Pet            @table @export — exercises MQTT-backed REST
 *   - Sensor         @table @export (schema-less) — exercises retained messages
 *
 * Fleet context:
 *   IBM prod (v4.7.32, 6-node)
 *   Ubisoft prod (v4.3.34, 7-node, %u)
 *   RAI Italia prod (v4.3.36, anonymousSubscriber)
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import jwt from 'jsonwebtoken';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

const PROJECT = 'mqtt-full';
const FIXTURE_PATH = resolve(import.meta.dirname, 'components/fixtures/mqtt-full');

let MQTT_URL = 'mqtt://localhost:1883';
const JWT_SECRET = 'integration-test-secret-not-verified';

const RC = {
	BAD_CREDS: [4, 134] as const,
	NOT_AUTHORIZED: [5, 128, 135] as const,
	SUBACK_DENIAL_CODES: [128, 135] as const,
	SUBACK_NO_RESOURCE: 143 as const,
} as const;

function isDenied(code: number | undefined): boolean {
	return code !== undefined && (RC.SUBACK_DENIAL_CODES as readonly number[]).includes(code);
}

function isNoResource(code: number | undefined): boolean {
	return code === RC.SUBACK_NO_RESOURCE;
}

function isRejected(code: number | undefined): boolean {
	return isDenied(code) || isNoResource(code);
}

function mintJwt(
	claims: { username: string; clientID: string; authGroups: string | string[] },
	opts: { algorithm?: string; signingKey?: string | Buffer } = {}
): string {
	const { algorithm = 'HS256', signingKey = JWT_SECRET } = opts;
	return jwt.sign({ ...claims, iat: Math.floor(Date.now() / 1000) }, signingKey as string, {
		algorithm: algorithm as jwt.Algorithm,
	});
}

function freshIdentities() {
	const suffix = randomUUID().slice(0, 8);
	return {
		pub: { username: `publisher-${suffix}`, clientID: `pubClient-${suffix}`, authGroups: 'dogPublisher' },
		sub: { username: `subscriber-${suffix}`, clientID: `subClient-${suffix}`, authGroups: 'dogSubscriber' },
		sysMon: { username: `sysMon-${suffix}`, clientID: `sysClient-${suffix}`, authGroups: 'sysMonitor' },
		alice: { username: `alice-${suffix}`, clientID: `aliceClient-${suffix}`, authGroups: ['userPub', 'userSub'] },
		bob: { username: `bob-${suffix}`, clientID: `bobClient-${suffix}`, authGroups: ['userPub', 'userSub'] },
	};
}

function baseOpts(overrides: Partial<IClientOptions> = {}): IClientOptions {
	return { protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 8000, clean: true, ...overrides };
}

function jwtOpts(token: string, clientId: string, username: string): IClientOptions {
	return baseOpts({ username, password: token, clientId });
}

function connect(url: string, opts: IClientOptions): Promise<MqttClient> {
	return new Promise((resolve, reject) => {
		const client = mqtt.connect(url, opts);
		const onError = (err: Error) => {
			client.removeListener('connect', onConnect);
			client.end(true);
			reject(err);
		};
		const onConnect = () => {
			client.removeListener('error', onError);
			resolve(client);
		};
		client.once('error', onError);
		client.once('connect', onConnect);
	});
}

function subscribe(client: MqttClient, topic: string, opts: { qos: 0 | 1 | 2 } = { qos: 1 }): Promise<any[]> {
	return new Promise((resolve, reject) => {
		client.subscribe(topic, opts, (err, granted) => {
			const subackGranted = (err as any)?.packet?.granted;
			if (Array.isArray(subackGranted)) resolve(subackGranted);
			else if (err) reject(err);
			else resolve(granted ?? []);
		});
	});
}

function publish(
	client: MqttClient,
	topic: string,
	payload: string,
	opts: { qos: 0 | 1 | 2; retain?: boolean } = { qos: 1 }
): Promise<void> {
	return new Promise((resolve, reject) => {
		client.publish(topic, payload, opts, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

function expectConnectFailure(
	url: string,
	opts: IClientOptions
): Promise<Error & { code?: number; reasonCode?: number }> {
	return new Promise((resolve, reject) => {
		const client = mqtt.connect(url, opts);
		const timer = setTimeout(() => {
			client.end(true);
			reject(new Error('expected CONNACK failure, timed out'));
		}, 8000);
		client.once('error', (err) => {
			clearTimeout(timer);
			client.end(true);
			resolve(err as Error & { code?: number });
		});
		client.once('connect', (packet) => {
			clearTimeout(timer);
			client.end(true);
			reject(new Error(`expected CONNACK failure, got success: ${JSON.stringify(packet)}`));
		});
	});
}

function reasonCodeOf(err: any): number | null {
	return err?.code ?? err?.reasonCode ?? err?.reasonCodes?.[0] ?? null;
}

function grantedCodes(granted: any[]): number[] {
	return granted.map((g) => (typeof g === 'number' ? g : (g.reasonCode ?? g.qos)));
}

function endQuiet(client: MqttClient | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!client) return resolve();
		client.end(true, {}, () => resolve());
	});
}

function topicMatches(filter: string, topic: string): boolean {
	const f = filter.split('/');
	const t = topic.split('/');
	for (let i = 0; i < f.length; i++) {
		if (f[i] === '#') return true;
		if (f[i] === '+') {
			if (t[i] === undefined) return false;
			continue;
		}
		if (f[i] !== t[i]) return false;
	}
	return f.length === t.length;
}

interface CollectedMessage {
	topic: string;
	payload: string;
}

function collectMessages(client: MqttClient, filter: string) {
	const messages: CollectedMessage[] = [];
	const handler = (topic: string, payload: Buffer) => {
		if (topicMatches(filter, topic)) {
			messages.push({ topic, payload: payload.toString() });
		}
	};
	client.on('message', handler);
	return { messages, stop: () => client.removeListener('message', handler) };
}

async function waitFor(
	predicate: () => boolean,
	opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
	const { timeoutMs = 5000, intervalMs = 50 } = opts;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(intervalMs);
	}
	return false;
}

function assertReasonIn(err: any, allowed: readonly number[], label: string): void {
	const code = reasonCodeOf(err);
	ok(
		code !== null && allowed.includes(code as number),
		`expected ${label} (one of ${allowed.join(', ')}), got ${code} (${err?.message})`
	);
}

// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun.
const skipSuite = process.env.HARPER_RUNTIME === 'bun';

suite(
	'MQTT integration: auth, ACL, QoS, %u, anonymousSubscriber, retained, SYS_CON',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		before(async () => {
			await startHarper(ctx);

			const httpURL = ctx.harper.httpURL;
			const wsScheme = httpURL.startsWith('https') ? 'wss' : 'ws';
			MQTT_URL = process.env.MQTT_FULL_URL ?? `${httpURL.replace(/^https?/, wsScheme)}/mqtt`;

			const deployBody = await sendOperation(ctx.harper, {
				operation: 'deploy_component',
				project: PROJECT,
				package: FIXTURE_PATH,
				restart: true,
			});
			strictEqual(deployBody.message, `Successfully deployed: ${PROJECT}, restarting Harper`);

			// Poll until the dog/# resource is registered (acl-connect startup race).
			const probe = freshIdentities().sub;
			const probeToken = mintJwt(probe);
			const deadline = Date.now() + 30_000;
			let ready = false;
			let lastSubackCode: number | undefined;
			let attempts = 0;
			while (Date.now() < deadline) {
				attempts++;
				let client: MqttClient | undefined;
				try {
					client = await connect(MQTT_URL, jwtOpts(probeToken, probe.clientID, probe.username));
					const granted = await subscribe(client, 'dog/#');
					lastSubackCode = grantedCodes(granted)[0];
					if (!isNoResource(lastSubackCode)) {
						ready = true;
						break;
					}
				} catch {
					// server restarting
				} finally {
					await endQuiet(client);
				}
				await sleep(500);
			}
			if (!ready) {
				throw new Error(
					`Timed out waiting for mqtt-full fixture after ${attempts} attempts. ` +
						`Last SUBACK code for dog/#: ${lastSubackCode ?? 'n/a'}`
				);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ── JWT auth ─────────────────────────────────────────────────────────────

		test('connects with valid HS256 JWT credentials', async () => {
			const { sub } = freshIdentities();
			const client = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
			ok(client.connected);
			await endQuiet(client);
		});

		test('RS256 JWT claims are extracted and connection succeeds', async () => {
			// RS256 tokens are decoded with jwt.decode() (no signature verification),
			// so any RSA key pair works here — the test verifies claim extraction.
			const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
			const { sub } = freshIdentities();
			const token = mintJwt(sub, { algorithm: 'RS256', signingKey: privateKey });
			const client = await connect(MQTT_URL, jwtOpts(token, sub.clientID, sub.username));
			ok(client.connected, 'RS256-signed JWT should be accepted (claims decoded without signature verification)');

			// Verify authGroups claim was correctly extracted by checking SUBACK
			try {
				const granted = await subscribe(client, 'dog/#');
				ok(!isDenied(grantedCodes(granted)[0]), `dogSubscriber group from RS256 JWT should grant dog/# subscription`);
			} finally {
				await endQuiet(client);
			}
		});

		test('invalid credentials are rejected', async () => {
			const err = await expectConnectFailure(
				MQTT_URL,
				baseOpts({
					username: `nope-${randomUUID().slice(0, 6)}`,
					password: 'definitely-wrong',
					clientId: `ci-bad-${randomUUID().slice(0, 8)}`,
				})
			);
			assertReasonIn(err, RC.BAD_CREDS, 'bad credentials');
		});

		test('mismatched MQTT clientId and JWT claim is rejected', async () => {
			const { sub } = freshIdentities();
			const err = await expectConnectFailure(
				MQTT_URL,
				jwtOpts(mintJwt(sub), `mismatched-${randomUUID().slice(0, 8)}`, sub.username)
			);
			assertReasonIn(err, [...RC.NOT_AUTHORIZED, ...RC.BAD_CREDS], 'clientId mismatch');
		});

		// ── ACL enforcement ──────────────────────────────────────────────────────

		test('publisher group subscribing to dog/# is denied', async () => {
			const { pub } = freshIdentities();
			const client = await connect(MQTT_URL, jwtOpts(mintJwt(pub), pub.clientID, pub.username));
			try {
				const granted = await subscribe(client, 'dog/#');
				ok(
					isDenied(grantedCodes(granted)[0]),
					`expected SUBACK denial for publisher on dog/#, got ${JSON.stringify(granted)}`
				);
			} finally {
				await endQuiet(client);
			}
		});

		test('subscriber group granted dog/# subscription and receives published messages', async () => {
			const { sub, pub } = freshIdentities();
			const subClient = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
			const pubClient = await connect(MQTT_URL, jwtOpts(mintJwt(pub), pub.clientID, pub.username));
			try {
				const granted = await subscribe(subClient, 'dog/#');
				ok(!isDenied(grantedCodes(granted)[0]), `dogSubscriber must get dog/# granted`);

				const obs = collectMessages(subClient, 'dog/#');
				const payload = `msg-${randomUUID()}`;
				await publish(pubClient, 'dog/1', payload);

				const arrived = await waitFor(() => obs.messages.some((m) => m.payload === payload), { timeoutMs: 5000 });
				obs.stop();
				ok(arrived, `subscriber did not receive published message on dog/1`);
			} finally {
				await endQuiet(pubClient);
				await endQuiet(subClient);
			}
		});

		// ── QoS semantics ────────────────────────────────────────────────────────

		test('QoS 0 publish and subscribe delivers message', async () => {
			const { sub, pub } = freshIdentities();
			const subClient = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
			const pubClient = await connect(MQTT_URL, jwtOpts(mintJwt(pub), pub.clientID, pub.username));
			try {
				await subscribe(subClient, 'dog/#', { qos: 0 });
				const obs = collectMessages(subClient, 'dog/#');
				const payload = `qos0-${randomUUID()}`;
				await publish(pubClient, 'dog/qos0', payload, { qos: 0 });
				const arrived = await waitFor(() => obs.messages.some((m) => m.payload === payload), { timeoutMs: 5000 });
				obs.stop();
				ok(arrived, 'QoS 0 message not received');
			} finally {
				await endQuiet(pubClient);
				await endQuiet(subClient);
			}
		});

		test('QoS 1 publish triggers PUBACK and delivers message', async () => {
			const { sub, pub } = freshIdentities();
			const subClient = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
			const pubClient = await connect(MQTT_URL, jwtOpts(mintJwt(pub), pub.clientID, pub.username));
			try {
				await subscribe(subClient, 'dog/#', { qos: 1 });
				const obs = collectMessages(subClient, 'dog/#');
				const payload = `qos1-${randomUUID()}`;
				// publish() resolves after PUBACK is received
				await publish(pubClient, 'dog/qos1', payload, { qos: 1 });
				const arrived = await waitFor(() => obs.messages.some((m) => m.payload === payload), { timeoutMs: 5000 });
				obs.stop();
				ok(arrived, 'QoS 1 message not received after PUBACK');
			} finally {
				await endQuiet(pubClient);
				await endQuiet(subClient);
			}
		});

		test('QoS 2 publish completes full PUBREC/PUBREL/PUBCOMP handshake and delivers message', async () => {
			const { sub, pub } = freshIdentities();
			const subClient = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
			const pubClient = await connect(MQTT_URL, jwtOpts(mintJwt(pub), pub.clientID, pub.username));
			try {
				await subscribe(subClient, 'dog/#', { qos: 2 });
				const obs = collectMessages(subClient, 'dog/#');
				const payload = `qos2-${randomUUID()}`;
				// mqtt.js handles PUBREC/PUBREL/PUBCOMP automatically; resolves after PUBCOMP
				await publish(pubClient, 'dog/qos2', payload, { qos: 2 });
				const arrived = await waitFor(() => obs.messages.some((m) => m.payload === payload), { timeoutMs: 5000 });
				obs.stop();
				ok(arrived, 'QoS 2 message not received after full handshake');
			} finally {
				await endQuiet(pubClient);
				await endQuiet(subClient);
			}
		});

		// ── %u topic substitution ────────────────────────────────────────────────

		test('%u: alice can subscribe to her own user-topics namespace', async () => {
			const { alice } = freshIdentities();
			const client = await connect(MQTT_URL, jwtOpts(mintJwt(alice), alice.clientID, alice.username));
			try {
				const granted = await subscribe(client, `user-topics/${alice.username}/data`);
				ok(
					!isRejected(grantedCodes(granted)[0]),
					`alice should subscribe to user-topics/${alice.username}/data, got ${JSON.stringify(granted)}`
				);
			} finally {
				await endQuiet(client);
			}
		});

		test('%u: alice cannot subscribe to bob user-topics namespace', async () => {
			const { alice, bob } = freshIdentities();
			const aliceClient = await connect(MQTT_URL, jwtOpts(mintJwt(alice), alice.clientID, alice.username));
			try {
				const granted = await subscribe(aliceClient, `user-topics/${bob.username}/data`);
				ok(
					isRejected(grantedCodes(granted)[0]),
					`alice must NOT subscribe to user-topics/${bob.username}/data, got ${JSON.stringify(granted)}`
				);
			} finally {
				await endQuiet(aliceClient);
			}
		});

		test('%u: alice can publish to her own user-topics namespace', async () => {
			const { alice } = freshIdentities();
			const aliceSub = await connect(MQTT_URL, jwtOpts(mintJwt(alice), alice.clientID, alice.username));
			const alicePub = await connect(
				MQTT_URL,
				jwtOpts(
					mintJwt({
						username: alice.username,
						clientID: `alicePubClient-${randomUUID().slice(0, 8)}`,
						authGroups: ['userPub', 'userSub'],
					}),
					`alicePubClient-${randomUUID().slice(0, 8)}`,
					alice.username
				)
			);
			try {
				await subscribe(aliceSub, `user-topics/${alice.username}/#`);
				const obs = collectMessages(aliceSub, `user-topics/${alice.username}/#`);
				const payload = `alice-msg-${randomUUID()}`;
				await publish(alicePub, `user-topics/${alice.username}/sensor`, payload, { qos: 1 });
				const arrived = await waitFor(() => obs.messages.some((m) => m.payload === payload), { timeoutMs: 5000 });
				obs.stop();
				ok(arrived, `alice should receive her own user-topics message`);
			} finally {
				await endQuiet(alicePub);
				await endQuiet(aliceSub);
			}
		});

		test('%u: alice publishing to bob user-topics namespace is rejected or silently dropped', async () => {
			const { alice, bob } = freshIdentities();
			const witness = await connect(MQTT_URL, jwtOpts(mintJwt(bob), bob.clientID, bob.username));
			const alicePub = await connect(MQTT_URL, jwtOpts(mintJwt(alice), alice.clientID, alice.username));
			try {
				// bob subscribes to his own namespace to witness any unexpected delivery
				const granted = await subscribe(witness, `user-topics/${bob.username}/#`);
				ok(!isRejected(grantedCodes(granted)[0]), `bob should subscribe to his own namespace`);

				const obs = collectMessages(witness, `user-topics/${bob.username}/#`);
				const payload = `alice-to-bob-${randomUUID()}`;
				// alice attempts to publish to bob's namespace — should be rejected or silently dropped
				try {
					await publish(alicePub, `user-topics/${bob.username}/data`, payload, { qos: 1 });
				} catch {
					// rejection is also acceptable
				}
				await sleep(1500);
				obs.stop();
				const seen = obs.messages.filter((m) => m.payload === payload);
				strictEqual(seen.length, 0, `alice must not publish to bob's user-topics namespace`);
			} finally {
				await endQuiet(alicePub);
				await endQuiet(witness);
			}
		});

		// ── anonymousSubscriber ──────────────────────────────────────────────────

		test('anonymous client can subscribe to anonymousSubscriber:true topic', async () => {
			// Anonymous: no username/password, no clientId, cleanSession=true
			const anonClient = await connect(
				MQTT_URL,
				baseOpts({ username: undefined, password: undefined, clientId: undefined })
			);
			try {
				const granted = await subscribe(anonClient, 'public/news');
				ok(
					!isRejected(grantedCodes(granted)[0]),
					`anonymous subscriber should get public/news granted (anonymousSubscriber:true), got ${JSON.stringify(granted)}`
				);
			} finally {
				await endQuiet(anonClient);
			}
		});

		test('anonymous client cannot subscribe to non-anonymous topic', async () => {
			const anonClient = await connect(
				MQTT_URL,
				baseOpts({ username: undefined, password: undefined, clientId: undefined })
			);
			try {
				const granted = await subscribe(anonClient, 'dog/#');
				ok(
					isRejected(grantedCodes(granted)[0]),
					`anonymous subscriber must NOT get dog/# (anonymousSubscriber:false), got ${JSON.stringify(granted)}`
				);
			} finally {
				await endQuiet(anonClient);
			}
		});

		// ── MQTT-backed REST table ────────────────────────────────────────────────

		test('PUT via REST triggers MQTT subscriber notification on Pet table', async () => {
			const adminUser = ctx.harper.admin.username;
			const adminPass = ctx.harper.admin.password;
			// Admin connects with standard credentials — super_user bypasses clientId check
			const adminClient = await connect(
				MQTT_URL,
				baseOpts({ username: adminUser, password: adminPass, clientId: adminUser })
			);
			try {
				const granted = await subscribe(adminClient, 'Pet/#', { qos: 1 });
				ok(!isRejected(grantedCodes(granted)[0]), `admin must subscribe to Pet/# table topic`);

				const obs = collectMessages(adminClient, 'Pet/#');
				const petId = `pet-${randomUUID().slice(0, 8)}`;
				const petName = `Buddy-${randomUUID().slice(0, 6)}`;

				// PUT via REST stores record and should trigger MQTT notification
				const authHeader = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString('base64')}`;
				const resp = await fetch(`${ctx.harper.httpURL}/Pet/${petId}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
					body: JSON.stringify({ name: petName }),
				});
				ok(resp.status < 300, `REST PUT should succeed, got ${resp.status}`);
				await resp.body?.cancel();

				const arrived = await waitFor(
					() => obs.messages.some((m) => m.topic === `Pet/${petId}` && m.payload.includes(petName)),
					{ timeoutMs: 8000 }
				);
				obs.stop();
				ok(arrived, `MQTT subscriber should receive Pet/${petId} update after REST PUT`);
			} finally {
				await endQuiet(adminClient);
			}
		});

		// ── Schema-less retained message table ───────────────────────────────────

		test('schema-less Sensor table: publish stored and retrievable by primary key', async () => {
			const adminUser = ctx.harper.admin.username;
			const adminPass = ctx.harper.admin.password;
			const authHeader = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString('base64')}`;
			const sensorId = `sensor-${randomUUID().slice(0, 8)}`;
			const temperature = Math.round(Math.random() * 100);

			// PUT arbitrary JSON (schema-less) into Sensor table via REST
			const putResp = await fetch(`${ctx.harper.httpURL}/Sensor/${sensorId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ temperature }),
			});
			ok(putResp.status < 300, `schema-less PUT should succeed, got ${putResp.status}`);
			await putResp.body?.cancel();

			// Subscribe via MQTT — new subscriber should immediately receive the retained value
			const adminClient = await connect(
				MQTT_URL,
				baseOpts({ username: adminUser, password: adminPass, clientId: adminUser })
			);
			try {
				const obs = collectMessages(adminClient, `Sensor/${sensorId}`);
				const granted = await subscribe(adminClient, `Sensor/${sensorId}`, { qos: 1 });
				ok(!isRejected(grantedCodes(granted)[0]), `admin must subscribe to Sensor/${sensorId}`);

				// Harper tables send current value immediately on subscription (retained-message behavior)
				const arrived = await waitFor(() => obs.messages.some((m) => m.topic === `Sensor/${sensorId}`), {
					timeoutMs: 5000,
				});
				obs.stop();
				ok(arrived, `Sensor/${sensorId} retained value should be delivered on subscribe`);

				// Also verifiable via REST GET
				const getResp = await fetch(`${ctx.harper.httpURL}/Sensor/${sensorId}`, {
					headers: { Authorization: authHeader },
				});
				strictEqual(getResp.status, 200, `GET Sensor/${sensorId} should return stored record`);
				const record = (await getResp.json()) as any;
				strictEqual(record.temperature, temperature, `schema-less record must contain published temperature`);
			} finally {
				await endQuiet(adminClient);
			}
		});

		// ── Durable session ──────────────────────────────────────────────────────

		test('durable session (cleanSession:false) delivers queued messages after reconnect', async () => {
			const adminUser = ctx.harper.admin.username;
			const adminPass = ctx.harper.admin.password;
			const authHeader = `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString('base64')}`;
			const durableId = `durable-${randomUUID().slice(0, 8)}`;
			const petKey = `dp-${randomUUID().slice(0, 8)}`;
			const petName = `Durable-${randomUUID().slice(0, 6)}`;

			// Step 1: connect with cleanSession:false and subscribe to Pet/# with QoS 1
			let subClient = await connect(
				MQTT_URL,
				baseOpts({ username: adminUser, password: adminPass, clientId: durableId, clean: false })
			);
			try {
				const granted = await subscribe(subClient, 'Pet/#', { qos: 1 });
				ok(!isRejected(grantedCodes(granted)[0]), `durable session must get Pet/# granted`);
			} finally {
				// Step 2: disconnect cleanly — session state is saved
				await endQuiet(subClient);
			}

			// Step 3: PUT a Pet record while the client is offline
			const putResp = await fetch(`${ctx.harper.httpURL}/Pet/${petKey}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ name: petName }),
			});
			ok(putResp.status < 300, `offline PUT should succeed, got ${putResp.status}`);
			await putResp.body?.cancel();

			// Step 4: reconnect with same clientId and cleanSession:false — queued messages delivered
			subClient = await connect(
				MQTT_URL,
				baseOpts({ username: adminUser, password: adminPass, clientId: durableId, clean: false })
			);
			try {
				const obs = collectMessages(subClient, 'Pet/#');
				const arrived = await waitFor(() => obs.messages.some((m) => m.payload.includes(petName)), { timeoutMs: 8000 });
				obs.stop();
				ok(arrived, `durable session should deliver Pet/${petKey} message queued while offline`);
			} finally {
				// Clean up: reconnect with cleanSession:true to delete the durable session
				await endQuiet(subClient);
				const cleanupClient = await connect(
					MQTT_URL,
					baseOpts({ username: adminUser, password: adminPass, clientId: durableId, clean: true })
				).catch(() => undefined);
				await endQuiet(cleanupClient);
			}
		});

		// ── MQTT + WebSocket ─────────────────────────────────────────────────────

		test('MQTT broker is accessible via WebSocket transport', async () => {
			// The test already uses WebSocket (MQTT_URL is a ws:// URL), so this
			// verifies the same broker is reachable and auth works over WebSocket.
			const { sub } = freshIdentities();
			const client = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
			ok(client.connected, 'WebSocket MQTT connection should succeed');
			await endQuiet(client);
		});

		// ── SYS_CON monitoring ───────────────────────────────────────────────────

		test('SYS_CON: connect emits $SYS/monitor/con/connects event', async () => {
			const { sysMon, sub } = freshIdentities();
			const monClient = await connect(MQTT_URL, jwtOpts(mintJwt(sysMon), sysMon.clientID, sysMon.username));
			try {
				const granted = await subscribe(monClient, '$SYS/monitor/con/#', { qos: 1 });
				ok(!isDenied(grantedCodes(granted)[0]), `sysMonitor must get $SYS/monitor/con/# granted`);
				const obs = collectMessages(monClient, '$SYS/monitor/con/#');
				const startIdx = obs.messages.length;

				const probe = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
				try {
					const arrived = await waitFor(
						() => obs.messages.slice(startIdx).some((m) => m.topic === '$SYS/monitor/con/connects'),
						{ timeoutMs: 4000 }
					);
					obs.stop();
					ok(arrived, `$SYS/monitor/con/connects must fire when a client connects`);
				} finally {
					await endQuiet(probe);
				}
			} finally {
				await endQuiet(monClient);
			}
		});

		test('SYS_CON: disconnect emits $SYS/drops', async () => {
			const { sysMon, sub } = freshIdentities();
			const monClient = await connect(MQTT_URL, jwtOpts(mintJwt(sysMon), sysMon.clientID, sysMon.username));
			try {
				await subscribe(monClient, '$SYS/#', { qos: 1 });
				const obs = collectMessages(monClient, '$SYS/#');

				const probe = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
				const startIdx = obs.messages.length;
				await endQuiet(probe);

				const arrived = await waitFor(
					() => obs.messages.slice(startIdx).some((m) => m.topic === '$SYS/drops' && m.payload.includes(sub.clientID)),
					{ timeoutMs: 4000 }
				);
				obs.stop();
				ok(arrived, `$SYS/drops must fire when ${sub.clientID} disconnects`);
			} finally {
				await endQuiet(monClient);
			}
		});

		// ── High-throughput SYS_CON ──────────────────────────────────────────────

		test('high-throughput: 1K rapid connect/disconnect events recorded in SYS_CON without data loss', async () => {
			const N = 1000;
			const { sysMon } = freshIdentities();
			const monClient = await connect(MQTT_URL, jwtOpts(mintJwt(sysMon), sysMon.clientID, sysMon.username));
			try {
				await subscribe(monClient, '$SYS/monitor/con/#', { qos: 1 });
				const obs = collectMessages(monClient, '$SYS/monitor/con/#');
				const startIdx = obs.messages.length;

				// Fire N connect/disconnect pairs concurrently in batches to avoid
				// overwhelming the event loop. 50 concurrent connections per batch.
				const BATCH = 50;
				for (let i = 0; i < N; i += BATCH) {
					const batchSize = Math.min(BATCH, N - i);
					await Promise.all(
						Array.from({ length: batchSize }, async () => {
							const id = freshIdentities().sub;
							let c: MqttClient | undefined;
							try {
								c = await connect(MQTT_URL, jwtOpts(mintJwt(id), id.clientID, id.username));
							} finally {
								await endQuiet(c);
							}
						})
					);
				}

				// Wait for SYS events to flush — all N connect events expected
				const flushed = await waitFor(
					() => obs.messages.slice(startIdx).filter((m) => m.topic === '$SYS/monitor/con/connects').length >= N,
					{ timeoutMs: 60_000, intervalMs: 500 }
				);
				obs.stop();
				const receivedCount = obs.messages
					.slice(startIdx)
					.filter((m) => m.topic === '$SYS/monitor/con/connects').length;
				ok(flushed, `expected ${N} $SYS/monitor/con/connects events, received ${receivedCount}`);
			} finally {
				await endQuiet(monClient);
			}
		});
	}
);
