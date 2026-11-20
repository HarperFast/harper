/**
 * `mqtt.network.connectionRateLimit` drops a source address's connections past its burst before the
 * TLS handshake and before any MQTT parsing, and the TCP and TLS ports share one allowance (harper#345).
 *
 * One thread, because the limit is per worker: with reusePort the kernel would spread one client's
 * connections across workers, each with its own allowance. The refill rate is low enough that no token
 * comes back during the suite.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/mqtt/connection-rate-limit.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';
import { connect as tlsConnect } from 'node:tls';

import mqtt, { type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'connection-rate-limit');
const CONNECT_TIMEOUT_MS = 8_000;

const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

suite('MQTT connection rate limit per source address', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	const clients: MqttClient[] = [];

	function connects(): Promise<boolean> {
		return new Promise((resolvePromise) => {
			const client = mqtt.connect(`mqtt://${ctx.harper.hostname}:1883`, {
				protocolVersion: 5,
				reconnectPeriod: 0,
				connectTimeout: CONNECT_TIMEOUT_MS,
				username: ctx.harper.admin.username,
				password: ctx.harper.admin.password,
			});
			clients.push(client);
			client.on('error', () => {});
			client.once('connect', () => resolvePromise(true));
			client.once('close', () => resolvePromise(false));
		});
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: {
				threads: { count: 1 },
				mqtt: { network: { connectionRateLimit: { perSecond: 0.001, burst: 2 } } },
			},
		});
	});

	after(async () => {
		for (const client of clients) client.end(true);
		await teardownHarper(ctx);
	});

	/** The TLS handshake's outcome on 8883, with the error code when it fails. */
	function tlsOutcome(): Promise<string> {
		return new Promise((resolvePromise) => {
			const socket = tlsConnect({ host: ctx.harper.hostname, port: 8883, rejectUnauthorized: false });
			const timer = setTimeout(() => resolvePromise('timeout'), CONNECT_TIMEOUT_MS);
			socket.once('secureConnect', () => {
				clearTimeout(timer);
				socket.destroy();
				resolvePromise('handshake');
			});
			socket.once('error', (error: NodeJS.ErrnoException) => {
				clearTimeout(timer);
				resolvePromise(error.code ?? 'error');
			});
		});
	}

	test('the TCP and TLS ports share one burst, and a connection past it is reset before TLS or CONNACK', async () => {
		strictEqual(await tlsOutcome(), 'handshake');
		ok(await connects(), 'the second connection of the burst was refused');
		strictEqual(await connects(), false);
		strictEqual(await tlsOutcome(), 'ECONNRESET');
	});
});
