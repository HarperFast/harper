/**
 * MQTT integration tests for features not covered by acl-connect.test.ts:
 *   - %u per-user topic substitution in topicFilters
 *   - anonymousSubscriber: true
 *   - $SYS/monitor/con/# monitoring events
 *   - JWT RS256 signature verification (server rejects tampered tokens)
 *
 * Fixture: integrationTests/components/fixtures/mqtt-user-sub
 * Implements RS256 JWT auth, chat/%u/# per-user topics, broadcast/# anonymous
 * subscribe, and $SYS/# sys-monitor group ACL.
 *
 * Relates to: https://github.com/HarperFast/harper/issues/1188
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID, createSign } from 'node:crypto';
import { resolve } from 'node:path';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

const PROJECT = 'mqtt-user-sub';
const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/mqtt-user-sub');

let MQTT_URL = '';

// RS256 private key that matches the public key embedded in the fixture's resources.js.
// This key is only for integration tests — never used in production.
const RS256_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCpj3ZjFOQ+vHca
XZifGlyZC+VZXtSI++1Vhl9qAnUS6ofVnNbPSsPDKKzxtn46uJD0qmYIYDHT1/D4
qJOVh4bN0jlATHPR/psZNkm0ygahAxTG5LbKSmx6e+icS9wbJnGLAQljuUq4kvvg
HTgSOTjljnI0XfgPWV+4yPylmiGWlwYwOEXJwegJckE1CabVF4vuqpJeIqfKCpqn
qswPAOUUdg9g+MOjGoEqUEkEcdtD34STcVLMCG/rUiDCHmCO3NOZIWy9bSgc5bQs
5FEMzwWuDep1TVttj+jxRTY/RjWc25IluZLYPtSLR/RWLcWJ5mo2mBUmakkriUAd
daPI6kSBAgMBAAECggEAAnVXtuIrOMBiZO/HViOzhN3J+YqtH88QwucdyCeA12lO
dr21VNgxeEl1P/Qolnz9b4murOeJo2fXqOBHUwE99msaTMUK/xf/G02I4inVcKVO
+l7/qjVL5zb3kXgNWPisx+JYBrHNnDlX1OkRinyZR0VCYUFdRsoxv8fst1ExtFlm
SSeturSnZxToZmMx6ZAh519oIi8N/w1IPw81ftka3GoMr74tnImx01ll/Ed7ELFN
71ucJfvg7yCdT1HtDaSRh9vmJ2HGmFMo+NpOIevF5eGp7rHGrVdEbFo9X78q+eB3
W+ChLtdRWF10eaWtJYc/wETTqE52PHuwTSBZjgkIUQKBgQDS5S9nGOLQ78FhlHXg
jqBzOJ3/wcJVzEWkN9/IjzvRxwGiR5E+Qp1t2ayTy5ssk3RxnpHVufMYFjQXDG2M
YnklrLgrQMhaJ7BRdt2e6JNr7gxONKKBvrsx10/vN6NebNzUGIX+AOQrX+erQCIo
bkWwlWZHowkWQPZnv+FoQLdbEQKBgQDN0yKhdmv8HJZ1XMI8cpq8gCYQn+3V3FqC
/74zjvcMDoTIfRwOHfGEy+xYLHAB+kH8mfcT+KqXKVlCjuoy8Lr+Au08FxMJkt5i
QMDnMKsfQbuCmEYfJSNqeDHNaC2qtEd9YdpnXhkOqHU5t+0fq9Rg6wuZPk78EgNv
1Gc9s5XycQKBgEAIvKLmKIBeO+5gAIalZ8x0ZWzxrQsWEhMxr+4ap4Qjk7htWIl5
+okPLdpWWRBo2VNiXU9yvYATxc81w9F7WON6lRT0/6B4Ko4htFr6rUB5MB1S2ADj
I72Xbbrpvt392fNAWvbr2FvfK92QhI6YJOrgAgVAWJL8OJT56vwXolSxAoGBAIav
I5kuickG1/niggPWJqU04jO8w4BPWjcgrNDGO6j7Ey6yl5oxQ+rXGkg0g/L3VRi7
k2/RJ6gU2aDxLhW5a1NujNjmbIG2RqlaoCBou4GPnOj/Rdt5jOxNzKESC9gJckJ8
ttMvQwxRdawYTCWOZkIpbISRvlO6Yd9ayVgZ3QQxAoGBALpB8oN7TgW/Vp7uUbRv
0Oo3qbmeU90y3TTneOHhpFIiNChjghdTOTQJ5uzKj3XzfopYb59iXmItoGjcv1AO
u6JIHOkNUk6NNKGdBu6Koj0gVgoGKpCTr70HttVFrilhq/XFpNiLD6/rZnNQrKU9
J+QnKpuY38d9F0meiEb7/aWl
-----END PRIVATE KEY-----`;

// SUBACK reason codes (see server/mqtt.ts).
const SUBACK_DENIAL_CODES = [128, 135] as const;
const CONNACK_BAD_CREDS = [4, 134] as const;
const CONNACK_NOT_AUTHORIZED = [5, 128, 135] as const;

function isDenied(code: number | undefined): boolean {
	return code !== undefined && (SUBACK_DENIAL_CODES as readonly number[]).includes(code);
}

/**
 * Produce a minimal RS256 JWT with the claims expected by the mqtt-user-sub fixture.
 * Uses Node.js crypto directly to avoid a jsonwebtoken build-time dependency in the test.
 */
function mintRS256Jwt(claims: { 'user-name': string; 'client-id': string; 'auth-groups': string }): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
	const signingInput = `${header}.${payload}`;
	const sign = createSign('RSA-SHA256');
	sign.update(signingInput);
	const signature = sign.sign(RS256_PRIVATE_KEY, 'base64url');
	return `${signingInput}.${signature}`;
}

/**
 * Produce a JWT with an invalid RS256 signature (i.e. signed with a different key).
 * The server must reject connections presenting this token.
 */
function mintTamperedJwt(claims: { 'user-name': string; 'client-id': string; 'auth-groups': string }): string {
	// Build a valid JWT and corrupt its signature bytes so jwt.verify() fails.
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
	// Replace the last few bytes of a valid signature to corrupt it.
	const validToken = mintRS256Jwt(claims);
	const parts = validToken.split('.');
	const corruptSig = parts[2].slice(0, -4) + 'XXXX';
	return `${header}.${payload}.${corruptSig}`;
}

function freshUser(role: string) {
	const suffix = randomUUID().slice(0, 8);
	return {
		'user-name': `user-${suffix}`,
		'client-id': `client-${suffix}`,
		'auth-groups': role,
	};
}

function baseOpts(overrides: Partial<IClientOptions> = {}): IClientOptions {
	return { protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 8000, clean: true, ...overrides };
}

function jwtOpts(token: string, user: { 'user-name': string; 'client-id': string }): IClientOptions {
	return baseOpts({
		username: user['user-name'],
		password: token,
		clientId: user['client-id'],
	});
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
	opts: { qos: 0 | 1 | 2 } = { qos: 1 }
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
			reject(new Error('expected CONNACK failure, timed out after 8 s'));
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
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

suite(
	'MQTT: %u substitution, anonymous subscriber, SYS_CON monitoring, RS256 auth',
	{ skip: skipSuite },
	(ctx: ContextWithHarper) => {
		before(async () => {
			await startHarper(ctx);

			const httpURL = ctx.harper.httpURL;
			const wsScheme = httpURL.startsWith('https') ? 'wss' : 'ws';
			MQTT_URL = process.env.MQTT_TEST_URL ?? `${httpURL.replace(/^https?/, wsScheme)}/mqtt`;

			const deployBody = await sendOperation(ctx.harper, {
				operation: 'deploy_component',
				project: PROJECT,
				package: FIXTURE_PATH,
				restart: true,
			});
			strictEqual(deployBody.message, `Successfully deployed: ${PROJECT}, restarting Harper`);

			// Poll until subscribe to broadcast/# returns a non-143 SUBACK (component registered).
			const probe = freshUser('subscriber');
			const probeToken = mintRS256Jwt(probe);
			const deadline = Date.now() + 30_000;
			let ready = false;
			let lastError: unknown = null;
			let lastCode: number | undefined;
			let attempts = 0;
			while (Date.now() < deadline) {
				attempts++;
				let client: MqttClient | undefined;
				try {
					client = await connect(MQTT_URL, jwtOpts(probeToken, probe));
					const granted = await subscribe(client, 'broadcast/#');
					lastCode = grantedCodes(granted)[0];
					// 143 = no resource registered yet; anything else means component is up.
					if (lastCode !== 143) {
						ready = true;
						break;
					}
				} catch (err) {
					lastError = err;
				} finally {
					await endQuiet(client);
				}
				await sleep(500);
			}
			if (!ready) {
				const err = lastError as any;
				throw new Error(
					`Timed out waiting for mqtt-user-sub after ${attempts} attempts. ` +
						`Last SUBACK code: ${lastCode ?? 'n/a'}. Last error: ${err?.message ?? err}`
				);
			}
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		// ---- RS256 auth -------------------------------------------------------

		test('RS256 JWT: valid token connects successfully', async () => {
			const user = freshUser('all');
			const token = mintRS256Jwt(user);
			const client = await connect(MQTT_URL, jwtOpts(token, user));
			ok(client.connected, 'expected MQTT client to be connected');
			await endQuiet(client);
		});

		test('RS256 JWT: tampered signature is rejected', async () => {
			const user = freshUser('all');
			const token = mintTamperedJwt(user);
			const err = await expectConnectFailure(MQTT_URL, jwtOpts(token, user));
			assertReasonIn(err, [...CONNACK_BAD_CREDS, ...CONNACK_NOT_AUTHORIZED], 'tampered RS256 token');
		});

		test('RS256 JWT: clientId mismatch between connect packet and token claim is rejected', async () => {
			const user = freshUser('all');
			const token = mintRS256Jwt(user);
			const mismatchOpts = baseOpts({
				username: user['user-name'],
				password: token,
				clientId: `mismatch-${randomUUID().slice(0, 8)}`,
			});
			const err = await expectConnectFailure(MQTT_URL, mismatchOpts);
			assertReasonIn(err, [...CONNACK_NOT_AUTHORIZED, ...CONNACK_BAD_CREDS], 'clientId mismatch');
		});

		// ---- %u substitution --------------------------------------------------

		test('%u substitution: user can subscribe and publish to their own chat/<username>/# topic', async () => {
			// Alice both subscribes and publishes on her own chat/alice/# namespace.
			// The 'all' group has publish and subscribe access, with %u expanding to
			// the authenticated username, so alice/chat/<alice-username>/# is allowed.
			const alice = freshUser('all');
			const aliceToken = mintRS256Jwt(alice);
			const aliceTopic = `chat/${alice['user-name']}/#`;

			const aliceClient = await connect(MQTT_URL, jwtOpts(aliceToken, alice));
			try {
				const granted = await subscribe(aliceClient, aliceTopic);
				ok(
					!isDenied(grantedCodes(granted)[0]),
					`expected alice to be granted ${aliceTopic}, got ${JSON.stringify(granted)}`
				);

				// Use a second connection for alice to publish (same user, different clientId not possible
				// with clientId enforcement — so use the same client for both pub and sub).
				const obs = collectMessages(aliceClient, aliceTopic);
				const sentPayload = `hello-${randomUUID()}`;
				await publish(aliceClient, `chat/${alice['user-name']}/hello`, sentPayload);

				const arrived = await waitFor(() => obs.messages.some((m) => m.payload === sentPayload), {
					timeoutMs: 5000,
				});
				obs.stop();
				ok(arrived, `expected message on ${aliceTopic}`);
			} finally {
				await endQuiet(aliceClient);
			}
		});

		test("%u substitution: user cannot subscribe to another user's chat/<other>/# topic", async () => {
			const alice = freshUser('all');
			const bob = freshUser('all');
			const aliceToken = mintRS256Jwt(alice);

			// Alice tries to subscribe to Bob's chat topic — must be denied because
			// the filter expands to chat/alice/# for Alice, not chat/bob/#.
			const client = await connect(MQTT_URL, jwtOpts(aliceToken, alice));
			try {
				const bobTopic = `chat/${bob['user-name']}/#`;
				const granted = await subscribe(client, bobTopic);
				ok(
					isDenied(grantedCodes(granted)[0]),
					`expected alice to be denied ${bobTopic}, got ${JSON.stringify(granted)}`
				);
			} finally {
				await endQuiet(client);
			}
		});

		test("%u substitution: user cannot publish to another user's chat/<other>/ topic", async () => {
			// Set up a witness (the "other" user) and a violator (a different user
			// trying to publish into the witness's topic space).
			const witness = freshUser('all');
			const violator = freshUser('all');
			const witnessToken = mintRS256Jwt(witness);
			const violatorToken = mintRS256Jwt(violator);

			const witnessClient = await connect(MQTT_URL, jwtOpts(witnessToken, witness));
			const violatorClient = await connect(MQTT_URL, jwtOpts(violatorToken, violator));
			try {
				const witnessTopic = `chat/${witness['user-name']}/#`;
				const granted = await subscribe(witnessClient, witnessTopic);
				ok(!isDenied(grantedCodes(granted)[0]), `precondition: witness must be able to subscribe to ${witnessTopic}`);

				const obs = collectMessages(witnessClient, witnessTopic);
				const payload = `intruder-${randomUUID()}`;
				// violator tries to publish to witness's topic — should be silently dropped or rejected
				await publish(violatorClient, `chat/${witness['user-name']}/msg`, payload).catch(() => undefined);

				await sleep(1500);
				obs.stop();

				const seen = obs.messages.filter((m) => m.payload === payload);
				strictEqual(seen.length, 0, `expected silent drop; witness saw: ${JSON.stringify(seen)}`);
			} finally {
				await endQuiet(witnessClient);
				await endQuiet(violatorClient);
			}
		});

		// ---- anonymousSubscriber: true ----------------------------------------

		test('anonymousSubscriber: unauthenticated client can subscribe to broadcast/#', async () => {
			// Use clientId: '' (empty string) — mqtt.js replaces undefined with a generated id,
			// which would fail the authorizeClient check for anonymous sessions that rejects
			// connections with any specified clientId.
			// Note: under the integration harness AUTHENTICATION_AUTHORIZELOCAL=true, loopback
			// connections are elevated to superuser before MQTT auth runs, so this test
			// validates the observable behavior (subscribe succeeds) rather than isolating the
			// anonymousSubscriber code path directly.
			const anonClient = await connect(MQTT_URL, baseOpts({ clientId: '' }));
			try {
				const granted = await subscribe(anonClient, 'broadcast/#');
				ok(
					!isDenied(grantedCodes(granted)[0]),
					`expected no-credential client to be granted broadcast/#, got ${JSON.stringify(granted)}`
				);
			} finally {
				await endQuiet(anonClient);
			}
		});

		test('anonymousSubscriber: anonymous connect succeeds with no credentials', async () => {
			// Verify that a client presenting no username/password can connect and disconnect cleanly.
			const anonClient = await connect(MQTT_URL, baseOpts({ clientId: '' }));
			ok(anonClient.connected, 'expected no-credential client to connect');
			await endQuiet(anonClient);
		});

		test('anonymousSubscriber: authenticated publisher can publish to broadcast/#', async () => {
			// publisher group has publish access to broadcast/#; verify messages arrive
			// at a no-credential subscriber.
			const pub = freshUser('publisher');
			const pubToken = mintRS256Jwt(pub);

			const pubClient = await connect(MQTT_URL, jwtOpts(pubToken, pub));
			const anonClient = await connect(MQTT_URL, baseOpts({ clientId: '' }));
			try {
				const granted = await subscribe(anonClient, 'broadcast/#');
				ok(
					!isDenied(grantedCodes(granted)[0]),
					`precondition: no-credential client must be able to subscribe to broadcast/#`
				);

				const obs = collectMessages(anonClient, 'broadcast/#');
				const sentPayload = `bcast-${randomUUID()}`;
				await publish(pubClient, 'broadcast/news', sentPayload);

				const arrived = await waitFor(() => obs.messages.some((m) => m.payload === sentPayload), {
					timeoutMs: 5000,
				});
				obs.stop();
				ok(arrived, 'expected broadcast message to reach no-credential subscriber');
			} finally {
				await endQuiet(pubClient);
				await endQuiet(anonClient);
			}
		});

		// ---- $SYS/monitor/con/# monitoring ------------------------------------

		test('$SYS/monitor/con/#: connecting event arrives when a client connects', async () => {
			const monitor = freshUser('sys-monitor');
			const monitorToken = mintRS256Jwt(monitor);
			const monitorClient = await connect(MQTT_URL, jwtOpts(monitorToken, monitor));

			try {
				const granted = await subscribe(monitorClient, '$SYS/monitor/con/#');
				ok(
					!isDenied(grantedCodes(granted)[0]),
					`expected sys-monitor to be granted $SYS/monitor/con/#, got ${JSON.stringify(granted)}`
				);

				const obs = collectMessages(monitorClient, '$SYS/monitor/con/#');
				const startIdx = obs.messages.length;

				// Trigger a new connection so a 'connecting' event fires.
				const probe = freshUser('all');
				const probeToken = mintRS256Jwt(probe);
				const probeClient = await connect(MQTT_URL, jwtOpts(probeToken, probe));
				try {
					const arrived = await waitFor(
						() => obs.messages.slice(startIdx).some((m) => m.topic === '$SYS/monitor/con/connects'),
						{ timeoutMs: 5000 }
					);
					obs.stop();
					ok(arrived, 'expected $SYS/monitor/con/connects event after a new client connected');
				} finally {
					await endQuiet(probeClient);
				}
			} finally {
				await endQuiet(monitorClient);
			}
		});

		test('$SYS/monitor/con/#: non-sys-monitor group cannot subscribe to $SYS/monitor/con/#', async () => {
			const user = freshUser('all');
			const token = mintRS256Jwt(user);
			const client = await connect(MQTT_URL, jwtOpts(token, user));
			try {
				const granted = await subscribe(client, '$SYS/monitor/con/#');
				ok(
					isDenied(grantedCodes(granted)[0]),
					`expected 'all' group to be denied $SYS/monitor/con/#, got ${JSON.stringify(granted)}`
				);
			} finally {
				await endQuiet(client);
			}
		});
	}
);
