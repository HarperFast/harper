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
	let deviceTls: Pick<IClientOptions, 'key' | 'cert' | 'ca'>;
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
		const deviceKeys = await generateEd25519KeyPair();
		const device = await createCertificate({
			serialNumber: 2,
			subject: { CN: DEVICE_CN },
			issuer: { CN: 'certsub test CA' },
			validDays: 2,
			issuerKey: caKeys.privateKey,
			subjectPublicKey: deviceKeys.publicKey,
			extensions: [makeExtKeyUsageExt([CLIENT_AUTH_OID])],
		});
		const caPath = join(certsPath, 'ca.pem');
		await writeFile(caPath, certToPem(ca));
		deviceTls = { key: deviceKeys.privateKeyPem, cert: certToPem(device), ca: certToPem(ca) };

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

	function connectDevice(url: string): Promise<MqttClient> {
		return new Promise((resolveConnect, reject) => {
			const mqttClient = mqtt.connect(url, {
				protocolVersion: 5,
				reconnectPeriod: 0,
				connectTimeout: 10_000,
				clean: true,
				rejectUnauthorized: false, // Harper serves its own self-signed certificate
				...deviceTls,
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

	test('a principal no certificate named, with no hdb_user, does not keep a subscription', async () => {
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
		const login = await fetch(ctx.harper.operationsAPIURL, {
			method: 'POST',
			// the session cookie is named for the origin it serves; the stream below goes to the REST port
			headers: { 'Content-Type': 'application/json', 'Origin': new URL(ctx.harper.httpURL).origin },
			body: JSON.stringify({ operation: 'login', ...DROPPED }),
		});
		strictEqual(login.status, 200, await login.text());
		const cookie = login.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.find((c) => c.includes('-hdb-session='));
		ok(cookie, `expected an hdb-session cookie, got ${JSON.stringify([...login.headers])}`);
		await client.req().send({ operation: 'drop_user', username: DROPPED.username }).expect(200);

		const streams = { token: openSse({ Authorization: `Bearer ${token}` }), cookie: openSse({ Cookie: cookie }) };
		try {
			await write();
			// admitted and then revoked by a recheck, or refused at admission (#4124): either way none survives
			for (const [credential, stream] of Object.entries(streams)) {
				ok(await waitFor(() => stream.ended, RECHECK_MS * 10), `the ${credential} subscription survived rechecks`);
			}
		} finally {
			for (const stream of Object.values(streams)) stream.destroy();
		}
	});
});
