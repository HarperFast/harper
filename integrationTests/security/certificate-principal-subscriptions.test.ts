import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
// @ts-expect-error utils/client.mjs has no type declarations; runtime resolves fine
import { createApiClient } from '../apiTests/utils/client.mjs';
import {
	CLIENT_AUTH_OID,
	certToPem,
	createCertificate,
	generateEd25519KeyPair,
	makeExtKeyUsageExt,
} from '../utils/security/certGenUtils.ts';

const FIXTURE_PATH = resolve(import.meta.dirname, '../fixtures/certificate-principal-subscriptions');
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

const RECHECK_MS = 500;
const HTTPS_PORT = 9927;
const MQTTS_PORT = 8883;
const DEVICE_CN = 'certsub-device';
const DROPPED = { username: 'certsub_dropped', password: 'Dropped-pw-4062!' };
const PEER_CN = 'certsub-peer';
const GATED_CN = 'certsub-gated';
const DURABLE_CN = 'certsub-durable';
const LATCH_CN = 'certsub-latch';
const BACKED_CN = 'certsub-backed';
const INACTIVE_CN = 'certsub-inactive';
const LEAF_CNS = [DEVICE_CN, PEER_CN, GATED_CN, DURABLE_CN, LATCH_CN, BACKED_CN, INACTIVE_CN];

type DeviceTls = Pick<IClientOptions, 'key' | 'cert' | 'ca'>;
type TopicSubscriber = { mqttClient: MqttClient; payloads: string[] };

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(25);
	}
	return predicate();
}

suite('Subscriptions of principals with no hdb_user (#4062)', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let client: ReturnType<typeof createApiClient>;
	let certsPath = '';
	let deviceTls: DeviceTls;
	const tlsByCn = new Map<string, DeviceTls>();
	let peer: TopicSubscriber | undefined;
	let seq = 0;
	const mqttClients: MqttClient[] = [];

	const write = () =>
		client
			.req()
			.send({ operation: 'upsert', schema: 'data', table: 'CertSubFeed', records: [{ id: 'hot', value: `v${seq++}` }] })
			.expect(200);

	before(async () => {
		certsPath = await mkdtemp(join(tmpdir(), 'harper-certsub-'));
		const caKeys = await generateEd25519KeyPair();
		const ca = await createCertificate({
			serialNumber: 1,
			subject: { CN: 'certsub test CA' },
			issuer: { CN: 'certsub test CA' },
			validDays: 2,
			issuerKey: caKeys.privateKey,
			subjectPublicKey: caKeys.publicKey,
			isCA: true,
		});
		for (const [index, cn] of LEAF_CNS.entries()) {
			const leafKeys = await generateEd25519KeyPair();
			const leaf = await createCertificate({
				serialNumber: 2 + index,
				subject: { CN: cn },
				issuer: { CN: 'certsub test CA' },
				validDays: 2,
				issuerKey: caKeys.privateKey,
				subjectPublicKey: leafKeys.publicKey,
				extensions: [makeExtKeyUsageExt([CLIENT_AUTH_OID])],
			});
			tlsByCn.set(cn, { key: leafKeys.privateKeyPem, cert: certToPem(leaf), ca: certToPem(ca) });
		}
		const caPath = join(certsPath, 'ca.pem');
		await writeFile(caPath, certToPem(ca));
		deviceTls = tlsByCn.get(DEVICE_CN)!;

		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				http: { mtls: { user: 'CN', required: false } },
				mqtt: { network: { mtls: { user: 'CN', required: false } } },
				tls: { certificateAuthority: caPath },
			},
			env: {
				AUTHENTICATION_AUTHORIZELOCAL: 'false',
				HARPER_SUBSCRIPTION_REAUTH_INTERVAL_MS: String(RECHECK_MS),
			},
		});
		client = createApiClient(ctx.harper);
		await write();
	});

	after(async () => {
		for (const mqttClient of mqttClients) mqttClient.end(true);
		await teardownHarper(ctx);
		await rm(certsPath, { recursive: true, force: true, maxRetries: 3 });
	});

	function connectDevice(url: string, options: IClientOptions = {}): Promise<MqttClient> {
		return new Promise((resolveConnect, reject) => {
			const mqttClient = mqtt.connect(url, {
				protocolVersion: 5,
				reconnectPeriod: 0,
				connectTimeout: 10_000,
				clean: true,
				rejectUnauthorized: false, // Harper serves its own self-signed certificate
				...deviceTls,
				...options,
			});
			mqttClients.push(mqttClient);
			mqttClient.once('connect', () => resolveConnect(mqttClient));
			mqttClient.once('error', reject);
		});
	}

	async function assertKeptAcrossRechecks(url: string) {
		const mqttClient = await connectDevice(url);
		let delivered = 0;
		let closed = false;
		mqttClient.on('message', () => delivered++);
		mqttClient.on('close', () => (closed = true));
		await mqttClient.subscribeAsync('CertSubFeed/hot', { qos: 1 });
		await write();
		ok(await waitFor(() => delivered > 0), 'the certificate principal was not admitted');

		await sleep(RECHECK_MS * 6);
		const before = delivered;
		await write();
		ok(await waitFor(() => delivered > before), 'a recheck revoked a certificate principal its allowRead still grants');
		strictEqual(closed, false, 'the connection closed');
		mqttClient.end(true);
	}

	test('an MQTT-over-TLS client whose certificate names no hdb_user keeps its subscription', async () => {
		await assertKeptAcrossRechecks(`mqtts://${ctx.harper.hostname}:${MQTTS_PORT}`);
	});

	test('an MQTT-over-WSS client whose certificate names no hdb_user keeps its subscription', async () => {
		await assertKeptAcrossRechecks(`wss://${ctx.harper.hostname}:${HTTPS_PORT}/mqtt`);
	});

	test('an HTTPS SSE client whose certificate names no hdb_user keeps its subscription', async () => {
		const stream = openSse({}, { certificate: true });
		try {
			await write();
			ok(
				await waitFor(() => stream.events > 0),
				`the certificate principal was not admitted (status ${stream.status})`
			);
			await sleep(RECHECK_MS * 6);
			const before = stream.events;
			await write();
			ok(
				await waitFor(() => stream.events > before),
				'a recheck revoked a certificate principal its allowRead still grants'
			);
			strictEqual(stream.ended, false, 'the stream ended');
		} finally {
			stream.destroy();
		}
	});

	function openSse(headers: Record<string, string>, { certificate = false } = {}) {
		const url = new URL(ctx.harper.httpURL);
		const stream = { events: 0, status: 0, ended: false, destroy: () => request.destroy() };
		const options = { path: '/CertSubFeed/hot', headers: { Accept: 'text/event-stream', ...headers } };
		const onResponse = (res: IncomingMessage) => {
			stream.status = res.statusCode ?? 0;
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => {
				for (const line of chunk.split('\n')) if (line.startsWith('data:') && line.slice(5).trim()) stream.events++;
			});
			res.on('close', () => (stream.ended = true));
		};
		const request = certificate
			? httpsRequest(
					{ ...options, hostname: ctx.harper.hostname, port: HTTPS_PORT, rejectUnauthorized: false, ...deviceTls },
					onResponse
				)
			: httpRequest({ ...options, hostname: url.hostname, port: url.port }, onResponse);
		request.on('error', () => (stream.ended = true));
		request.end();
		return stream;
	}

	test('a dropped user’s token and cookie are refused at subscription admission', async () => {
		await client
			.req()
			.send({ operation: 'add_role', role: 'certsub_role', permission: { super_user: false, data: { tables: {} } } })
			.expect(200);
		await client
			.req()
			.send({ operation: 'add_user', role: 'certsub_role', active: true, ...DROPPED })
			.expect(200);
		const tokens = await client
			.req()
			.send({ operation: 'create_authentication_tokens', ...DROPPED, expires_in: 300 })
			.expect(200);
		const token = tokens.body?.operation_token;
		ok(token, 'expected an operation_token');
		const origin = new URL(ctx.harper.httpURL).origin;
		const login = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			// the session cookie is named for the origin it serves; the stream below goes to the REST port
			headers: { 'Content-Type': 'application/json', 'Origin': origin },
			body: JSON.stringify({ operation: 'login', ...DROPPED }),
		});
		strictEqual(login.status, 200, await login.text());
		const cookie = login.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.find((c) => c.includes('-hdb-session='));
		ok(cookie, `expected an hdb-session cookie, got ${JSON.stringify([...login.headers])}`);
		await client.reqAs({ Cookie: cookie, Origin: origin }).send({ operation: 'user_info' }).expect(200);
		await client.req().send({ operation: 'drop_user', username: DROPPED.username }).expect(200);

		const streams = { token: openSse({ Authorization: `Bearer ${token}` }), cookie: openSse({ Cookie: cookie }) };
		try {
			for (const [credential, stream] of Object.entries(streams)) {
				ok(await waitFor(() => stream.status !== 0), `expected a response for the ${credential}`);
				strictEqual(stream.status, 401, `expected admission to refuse the ${credential}`);
			}
		} finally {
			for (const stream of Object.values(streams)) stream.destroy();
		}
	});

	const operation = (body: Record<string, unknown>) => client.req().send(body).expect(200);

	async function writeTopic(id: string): Promise<string> {
		const value = `certsub-topic-${seq++}`;
		await operation({ operation: 'upsert', schema: 'data', table: 'CertSubTopic', records: [{ id, value }] });
		return value;
	}

	async function receives(subscriber: TopicSubscriber, cn: string, timeoutMs = 3000): Promise<boolean> {
		const value = await writeTopic(cn);
		return waitFor(() => subscriber.payloads.some((payload) => payload.includes(`"${value}"`)), timeoutMs);
	}

	async function subscribeOwnTopic(cn: string, options: IClientOptions = {}): Promise<TopicSubscriber> {
		const mqttClient = await connectDevice(`mqtts://${ctx.harper.hostname}:${MQTTS_PORT}`, {
			...tlsByCn.get(cn),
			...options,
		});
		const subscriber = { mqttClient, payloads: [] as string[] };
		mqttClient.on('message', (_topic, payload) => subscriber.payloads.push(payload.toString()));
		await mqttClient.subscribeAsync(`CertSubTopic/${cn}`, { qos: 1 });
		ok(await receives(subscriber, cn), `${cn} was not admitted`);
		return subscriber;
	}

	async function peerSubscriber(): Promise<TopicSubscriber> {
		peer ??= await subscribeOwnTopic(PEER_CN);
		return peer;
	}

	async function keptAcrossRechecks(subscriber: TopicSubscriber, cn: string): Promise<boolean> {
		await sleep(RECHECK_MS * 6);
		return receives(subscriber, cn);
	}

	/**
	 * A revoked MQTT subscription is not disconnected (#4327), so a cut-off is two consecutive writes that miss
	 * `subscriber` while the peer still receives.
	 */
	async function cutOffWhilePeerReceives(subscriber: TopicSubscriber, cn: string): Promise<boolean> {
		const peerClient = await peerSubscriber();
		const deadline = Date.now() + RECHECK_MS * 10;
		do {
			const served = (await receives(subscriber, cn, RECHECK_MS)) || (await receives(subscriber, cn, 2000));
			ok(await receives(peerClient, PEER_CN), 'a certificate client nothing revoked stopped receiving');
			if (!served) return true;
		} while (Date.now() < deadline);
		return false;
	}

	test('withdrawing an allowRead grant ends that certificate client alone', async () => {
		// admitted first: a teardown of every subscription at the withdrawal must fail the peer
		await peerSubscriber();
		const gated = await subscribeOwnTopic(GATED_CN);
		ok(
			await keptAcrossRechecks(gated, GATED_CN),
			'a recheck revoked a certificate principal its allowRead still grants'
		);
		await operation({
			operation: 'upsert',
			schema: 'data',
			table: 'CertSubGate',
			records: [{ id: GATED_CN, revoked: true }],
		});
		ok(await cutOffWhilePeerReceives(gated, GATED_CN), 'the subscription outlived the grant allowRead withdrew');
		await operation({
			operation: 'upsert',
			schema: 'data',
			table: 'CertSubGate',
			records: [{ id: GATED_CN, revoked: false }],
		});
		ok(!(await keptAcrossRechecks(gated, GATED_CN)), 'restoring the grant revived a subscription that had ended');
	});

	test('a durable session resumed by a certificate that names no hdb_user keeps its subscription', async () => {
		const session: IClientOptions = {
			clean: false,
			clientId: 'certsub-durable-session',
			properties: { sessionExpiryInterval: 300 },
		};
		const first = await subscribeOwnTopic(DURABLE_CN, session);
		await first.mqttClient.endAsync();
		const mqttClient = await connectDevice(`mqtts://${ctx.harper.hostname}:${MQTTS_PORT}`, {
			...tlsByCn.get(DURABLE_CN),
			...session,
		});
		const resumed = { mqttClient, payloads: [] as string[] };
		mqttClient.on('message', (_topic, payload) => resumed.payloads.push(payload.toString()));
		ok(await receives(resumed, DURABLE_CN), 'the session was not resumed with its subscription');
		ok(
			await keptAcrossRechecks(resumed, DURABLE_CN),
			'a recheck revoked the resumed session of a certificate principal'
		);
	});

	test('once an hdb_user record backs the name, the connection needs a role even after drop_user', async () => {
		const latched = await subscribeOwnTopic(LATCH_CN);
		ok(
			await keptAcrossRechecks(latched, LATCH_CN),
			'a recheck revoked a certificate principal its allowRead still grants'
		);
		await operation({ operation: 'add_role', role: 'certsub_no_read', permission: { super_user: false } });
		await operation({
			operation: 'add_user',
			role: 'certsub_no_read',
			active: true,
			username: LATCH_CN,
			password: 'Latch-pw-4062!',
		});
		// only a recheck that finds the record sets the latch, and nothing reports one
		for (let window = 0; window < 2; window++) {
			ok(await keptAcrossRechecks(latched, LATCH_CN), 'a role-bearing record ended a subscription allowRead grants');
		}
		await operation({ operation: 'drop_user', username: LATCH_CN });
		ok(
			await cutOffWhilePeerReceives(latched, LATCH_CN),
			'a connection whose name a record once backed kept its subscription with no role'
		);
	});

	test('a certificate that names an hdb_user loses its subscription with that user', async () => {
		await operation({ operation: 'add_role', role: 'certsub_backed_role', permission: { super_user: false } });
		for (const username of [BACKED_CN, INACTIVE_CN]) {
			await operation({
				operation: 'add_user',
				role: 'certsub_backed_role',
				active: true,
				username,
				password: 'Backed-pw-4062!',
			});
		}
		const backed = await subscribeOwnTopic(BACKED_CN);
		const inactive = await subscribeOwnTopic(INACTIVE_CN);
		ok(await keptAcrossRechecks(backed, BACKED_CN), 'a recheck revoked a certificate principal with a role');
		ok(await receives(inactive, INACTIVE_CN), 'a recheck revoked a certificate principal with a role');

		await operation({ operation: 'drop_user', username: BACKED_CN });
		ok(await cutOffWhilePeerReceives(backed, BACKED_CN), "a dropped user's certificate kept its subscription");
		ok(await receives(inactive, INACTIVE_CN), "dropping one user ended another user's certificate subscription");
		await operation({ operation: 'alter_user', username: INACTIVE_CN, active: false });
		ok(await cutOffWhilePeerReceives(inactive, INACTIVE_CN), "an inactive user's certificate kept its subscription");
	});
});
