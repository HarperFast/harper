/**
 * acl-connect component integration test.
 *
 * Deploys @harperdb/acl-connect via fixtures/acl-connect-with-sys (a
 * near-verbatim copy of acl-connect-example with a $SYS/# ACL added to
 * connect.json) and verifies JWT auth, ACL enforcement, wildcard delivery,
 * and $SYS monitoring events.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import jwt from 'jsonwebtoken';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { startHarper, teardownHarper, sendOperation, type ContextWithHarper } from '@harperfast/integration-testing';

const PROJECT = 'acl-connect-with-sys';
const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/acl-connect-with-sys');

let MQTT_URL = process.env.ACL_MQTT_URL ?? 'mqtt://localhost:1883';
const JWT_SECRET = 'integration-test-secret-not-verified';

// SUBACK reason codes per server/mqtt.ts: 135 = ACL denied, 143 = no resource registered.
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

function mintJwt(claims: { username: string; clientID: string; authGroups: string | string[] }): string {
	return jwt.sign({ ...claims, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { algorithm: 'HS256' });
}

function freshIdentities() {
	const suffix = randomUUID().slice(0, 8);
	return {
		pub: { username: `publisher-${suffix}`, clientID: `pubClient-${suffix}`, authGroups: 'dogPublisher' },
		sub: { username: `subscriber-${suffix}`, clientID: `subClient-${suffix}`, authGroups: 'dogSubscriber' },
		sysSub: { username: `sysSub-${suffix}`, clientID: `sysClient-${suffix}`, authGroups: 'sysSubscriber' },
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
			// mqtt v5 surfaces a failure SUBACK as ErrorWithSubackPacket; the
			// denial codes (e.g. 135 Not authorized, 143 Topic Filter invalid)
			// live on err.packet.granted and are what callers want to inspect.
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

// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun, so the
// suite setup times out. Match the skip pattern used by other apiTests that
// hit MQTT/WS surfaces.
const skipSuite = process.env.HARPER_RUNTIME === 'bun';

suite('Component: acl-connect', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	before(async () => {
		await startHarper(ctx);

		const httpURL = ctx.harper.httpURL;
		const wsScheme = httpURL.startsWith('https') ? 'wss' : 'ws';
		MQTT_URL = process.env.ACL_MQTT_URL ?? `${httpURL.replace(/^https?/, wsScheme)}/mqtt`;

		const deployBody = await sendOperation(ctx.harper, {
			operation: 'deploy_component',
			project: PROJECT,
			package: FIXTURE_PATH,
			restart: true,
		});
		strictEqual(deployBody.message, `Successfully deployed: ${PROJECT}, restarting Harper`);

		// poll until SUBSCRIBE to dog/# returns a non-143 SUBACK — covers the
		// race where JWT connect succeeds before @harperdb/acl-connect has
		// registered dog as a resource on a freshly restarted worker.
		const probe = freshIdentities().sub;
		const probeToken = mintJwt(probe);
		const deadline = Date.now() + 30_000;
		let ready = false;
		let lastError: unknown = null;
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
				`Timed out waiting for acl-connect after ${attempts} attempts on ${MQTT_URL}. ` +
					`Last SUBACK code for dog/#: ${lastSubackCode ?? 'n/a'}. Last error: ${err?.message ?? err}`
			);
		}
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('subscriber JWT connects', async () => {
		const { sub } = freshIdentities();
		const client = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
		ok(client.connected, 'expected MQTT client to be connected');
		await endQuiet(client);
	});

	test('publisher JWT connects', async () => {
		const { pub } = freshIdentities();
		const client = await connect(MQTT_URL, jwtOpts(mintJwt(pub), pub.clientID, pub.username));
		ok(client.connected, 'expected MQTT client to be connected');
		await endQuiet(client);
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

	test('mismatched MQTT clientId is rejected', async () => {
		const { sub } = freshIdentities();
		const err = await expectConnectFailure(
			MQTT_URL,
			jwtOpts(mintJwt(sub), `mismatched-${randomUUID().slice(0, 8)}`, sub.username)
		);
		assertReasonIn(err, [...RC.NOT_AUTHORIZED, ...RC.BAD_CREDS], 'clientId mismatch reject');
	});

	test('publisher subscribing to dog/# is rejected', async () => {
		const { pub } = freshIdentities();
		const client = await connect(MQTT_URL, jwtOpts(mintJwt(pub), pub.clientID, pub.username));
		try {
			const granted = await subscribe(client, 'dog/#');
			ok(isDenied(grantedCodes(granted)[0]), `expected SUBACK denial, got ${JSON.stringify(granted)}`);
		} finally {
			await endQuiet(client);
		}
	});

	test('subscribe to topic with no ACL is rejected', async () => {
		const { sub } = freshIdentities();
		const client = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
		try {
			const granted = await subscribe(client, 'cat/#');
			ok(isRejected(grantedCodes(granted)[0]), `expected SUBACK rejection, got ${JSON.stringify(granted)}`);
		} finally {
			await endQuiet(client);
		}
	});

	test('unauthorized publish to dog/1 is silently dropped', async () => {
		const witnessId = freshIdentities().sub;
		const violatorId = freshIdentities().sub;
		const witness = await connect(MQTT_URL, jwtOpts(mintJwt(witnessId), witnessId.clientID, witnessId.username));
		const violator = await connect(MQTT_URL, jwtOpts(mintJwt(violatorId), violatorId.clientID, violatorId.username));
		try {
			const granted = await subscribe(witness, 'dog/#');
			ok(!isDenied(grantedCodes(granted)[0]), `precondition: dog/# must be granted, got ${JSON.stringify(granted)}`);

			const obs = collectMessages(witness, 'dog/#');
			const payload = `from-violator-${randomUUID()}`;
			await publish(violator, 'dog/1', payload).catch(() => undefined);

			await sleep(1500);
			obs.stop();

			const seen = obs.messages.filter((m) => m.payload === payload);
			strictEqual(seen.length, 0, `expected silent drop, witness saw: ${JSON.stringify(seen)}`);
		} finally {
			await endQuiet(violator);
			await endQuiet(witness);
		}
	});

	test('publish to topic with no ACL is dropped or rejected', async () => {
		const { pub } = freshIdentities();
		const client = await connect(MQTT_URL, jwtOpts(mintJwt(pub), pub.clientID, pub.username));
		try {
			try {
				await publish(client, 'cat/1', `unrouted-${randomUUID()}`);
				// silent drop with PUBACK success — accepted
			} catch (err) {
				const code = (err as any)?.code;
				ok(isDenied(code), `expected silent drop or denial code, got publish error code=${code}`);
			}
		} finally {
			await endQuiet(client);
		}
	});

	test('wildcard subscriber receives messages at all sub-topic depths', async () => {
		const TOPICS = [
			'dog/1',
			'dog/2',
			'dog/golden',
			'dog/breed/labrador',
			'dog/breed/poodle',
			'dog/US/12345',
			'dog/EU/67890',
			'dog/a/b/c/d',
		];

		const { sub, pub } = freshIdentities();
		const subClient = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
		const pubClient = await connect(MQTT_URL, jwtOpts(mintJwt(pub), pub.clientID, pub.username));
		try {
			const granted = await subscribe(subClient, 'dog/#');
			ok(!isDenied(grantedCodes(granted)[0]), `precondition: dog/# must be granted, got ${JSON.stringify(granted)}`);

			const obs = collectMessages(subClient, 'dog/#');
			const expected = new Map(TOPICS.map((t) => [t, `wc-${t}-${randomUUID()}`]));
			for (const [topic, payload] of expected) {
				await publish(pubClient, topic, payload);
			}

			const allArrived = await waitFor(() => obs.messages.length >= TOPICS.length, { timeoutMs: 5000 });
			obs.stop();
			ok(allArrived, `expected ${TOPICS.length} messages, got ${obs.messages.length}`);

			for (const [topic, payload] of expected) {
				const found = obs.messages.find((m) => m.topic === topic && m.payload === payload);
				ok(found, `missing delivery for ${topic}`);
			}
		} finally {
			await endQuiet(pubClient);
			await endQuiet(subClient);
		}
	});

	test('successful connect emits $SYS/monitor/con/connects and $SYS/connects', async () => {
		// the connecting event fires before auth completes and has no clientId; only
		// assert it arrives. the connected event carries the session, so match clientID.
		const { sysSub, sub } = freshIdentities();
		const adminSub = await connect(MQTT_URL, jwtOpts(mintJwt(sysSub), sysSub.clientID, sysSub.username));
		try {
			const granted = await subscribe(adminSub, '$SYS/#');
			ok(!isDenied(grantedCodes(granted)[0]), `precondition: $SYS/# must be granted, got ${JSON.stringify(granted)}`);
			const sysObs = collectMessages(adminSub, '$SYS/#');
			const startIdx = sysObs.messages.length;

			const probe = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
			try {
				const arrived = await waitFor(
					() => {
						const fresh = sysObs.messages.slice(startIdx);
						return (
							fresh.some((m) => m.topic === '$SYS/monitor/con/connects') &&
							fresh.some((m) => m.topic === '$SYS/connects' && m.payload.includes(sub.clientID))
						);
					},
					{ timeoutMs: 4000 }
				);
				sysObs.stop();
				ok(arrived, `expected connecting + connected $SYS events for ${sub.clientID}`);
			} finally {
				await endQuiet(probe);
			}
		} finally {
			await endQuiet(adminSub);
		}
	});

	test('disconnect emits $SYS/drops', async () => {
		const { sysSub, sub } = freshIdentities();
		const adminSub = await connect(MQTT_URL, jwtOpts(mintJwt(sysSub), sysSub.clientID, sysSub.username));
		try {
			await subscribe(adminSub, '$SYS/#');
			const sysObs = collectMessages(adminSub, '$SYS/#');

			const probe = await connect(MQTT_URL, jwtOpts(mintJwt(sub), sub.clientID, sub.username));
			const startIdx = sysObs.messages.length;
			await endQuiet(probe);

			const arrived = await waitFor(
				() => sysObs.messages.slice(startIdx).some((m) => m.topic === '$SYS/drops' && m.payload.includes(sub.clientID)),
				{ timeoutMs: 4000 }
			);
			sysObs.stop();
			ok(arrived, `expected $SYS/drops for ${sub.clientID}`);
		} finally {
			await endQuiet(adminSub);
		}
	});

	test('auth failure emits $SYS/errors and $SYS/drops', async () => {
		// $SYS/drops on auth-failed close has no clientId (session is undefined),
		// so we only assert that some drops event arrives in the post-failure window.
		const { sysSub } = freshIdentities();
		const adminSub = await connect(MQTT_URL, jwtOpts(mintJwt(sysSub), sysSub.clientID, sysSub.username));
		try {
			await subscribe(adminSub, '$SYS/#');
			const sysObs = collectMessages(adminSub, '$SYS/#');
			const startIdx = sysObs.messages.length;

			const failId = `sys-fail-${randomUUID().slice(0, 8)}`;
			await expectConnectFailure(MQTT_URL, baseOpts({ username: 'nope', password: 'wrong', clientId: failId }));

			const arrived = await waitFor(
				() => {
					const fresh = sysObs.messages.slice(startIdx);
					return (
						fresh.some((m) => m.topic === '$SYS/errors' && m.payload.includes(failId)) &&
						fresh.some((m) => m.topic === '$SYS/drops')
					);
				},
				{ timeoutMs: 4000 }
			);
			sysObs.stop();
			ok(arrived, `expected $SYS/errors (with ${failId}) + $SYS/drops for failed auth`);
		} finally {
			await endQuiet(adminSub);
		}
	});

	// regression for @harperdb/acl-connect PR #10 (auth-failed-password-leak, fixed in 1.0.10).
	test('auth-failed event does not leak plaintext password', async () => {
		const { sysSub } = freshIdentities();
		const observer = await connect(MQTT_URL, jwtOpts(mintJwt(sysSub), sysSub.clientID, sysSub.username));
		try {
			await subscribe(observer, '$SYS/errors');
			const obs = collectMessages(observer, '$SYS/errors');

			const failId = `sys-leak-${randomUUID().slice(0, 8)}`;
			const secret = `s3cret-${randomUUID()}`;
			await expectConnectFailure(MQTT_URL, baseOpts({ username: 'nope', password: secret, clientId: failId }));

			await waitFor(() => obs.messages.some((m) => m.payload.includes(failId)), { timeoutMs: 4000 });
			obs.stop();

			const evt = obs.messages.find((m) => m.payload.includes(failId));
			ok(evt, `expected $SYS/errors event for ${failId}`);
			ok(
				!evt!.payload.includes(secret),
				`auth-failed event leaked plaintext password (${secret} found in $SYS/errors)`
			);
			const parsed = JSON.parse(evt!.payload);
			ok(
				parsed.password === undefined || parsed.password === null,
				`auth-failed event must omit password field; got ${JSON.stringify(parsed.password)}`
			);
		} finally {
			await endQuiet(observer);
		}
	});
});
