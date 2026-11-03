/**
 * An MQTT v5 client with no user that is refused by a resource must be told "Not authorized" (0x87),
 * not "Unspecified error" (0x80), on both SUBACK and PUBACK (harper#3298). A refused CONNECT must carry
 * the code of the client's own protocol version: reason codes for v5, return codes for 3.1.1.
 * The sibling suites accept either code as a denial, so this one pins the exact value over a real connection.
 *
 * `mqtt.requireAuthentication` is off so a CONNECT with no username succeeds, and `authorizeLocal` is
 * off because the harness otherwise elevates every loopback connection to a super user, so the
 * request would never reach the resource without a user.
 *
 * Run:
 *   npm run test:integration -- "integrationTests/mqtt/mqtt-not-authorized.test.ts"
 */
import { suite, test, before, after } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { resolve } from 'node:path';

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';

const FIXTURE_PATH = resolve(import.meta.dirname, 'mqtt-not-authorized');

const NOT_AUTHORIZED = 0x87;
const UNSPECIFIED_ERROR = 0x80;
const BAD_CREDENTIALS = 0x86;
const BAD_CREDENTIALS_311 = 4;
const NOT_AUTHORIZED_311 = 5;
const ACK_TIMEOUT_MS = 8_000;

// mqtt.js's WebSocket transport doesn't complete CONNACK on Bun.
const skipSuite = process.env.HARPER_RUNTIME === 'bun' || process.platform === 'win32';

suite('MQTT: a request with no user is refused as Not authorized', { skip: skipSuite }, (ctx: ContextWithHarper) => {
	let mqttURL = '';

	function options(overrides: Partial<IClientOptions> = {}): IClientOptions {
		return { protocolVersion: 5, reconnectPeriod: 0, connectTimeout: 8_000, clean: true, ...overrides };
	}

	function connect(overrides: Partial<IClientOptions> = {}): Promise<MqttClient> {
		return new Promise((resolvePromise, reject) => {
			const client = mqtt.connect(mqttURL, options(overrides));
			client.once('error', (error) => {
				client.end(true);
				reject(error);
			});
			client.once('connect', () => {
				client.on('error', () => {});
				resolvePromise(client);
			});
		});
	}

	function end(client: MqttClient): Promise<void> {
		return new Promise((resolvePromise) => client.end(true, {}, () => resolvePromise()));
	}

	/** mqtt.js rejects a refused CONNECT with an error whose `code` is the CONNACK's reason or return code. */
	function refusedCode(overrides: Partial<IClientOptions>): Promise<number | undefined> {
		return new Promise((resolvePromise, reject) => {
			const client = mqtt.connect(mqttURL, options(overrides));
			const timer = setTimeout(() => {
				client.end(true);
				reject(new Error('no CONNACK refusal within the deadline'));
			}, ACK_TIMEOUT_MS);
			client.once('error', (error) => {
				clearTimeout(timer);
				client.end(true);
				resolvePromise((error as any).code);
			});
			client.once('connect', () => {
				clearTimeout(timer);
				client.end(true);
				reject(new Error('expected a refused CONNECT, got a CONNACK success'));
			});
		});
	}

	/** The connect timeout covers the CONNACK only, so an acknowledgment that never comes needs its own deadline. */
	function acknowledged<T>(what: string, pending: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout>;
		const expired = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`no ${what} within ${ACK_TIMEOUT_MS} ms`)), ACK_TIMEOUT_MS);
		});
		return Promise.race([pending, expired]).finally(() => clearTimeout(timer));
	}

	/** On a refusal mqtt.js hands the callback an error carrying the broker's SUBACK; its `granted` argument is the request. */
	function subscribe(client: MqttClient, topic: string) {
		return acknowledged(
			`SUBACK for ${topic}`,
			new Promise<{ code: number | undefined; reasonString: string | undefined }>((resolvePromise) => {
				client.subscribe(topic, { qos: 1 }, (error, granted) => {
					const packet = (error as any)?.packet;
					resolvePromise({
						code: Array.isArray(packet?.granted) ? packet.granted[0] : (granted?.[0] as any)?.qos,
						reasonString: packet?.properties?.reasonString,
					});
				});
			})
		);
	}

	function publish(client: MqttClient, topic: string) {
		return acknowledged(
			`PUBACK for ${topic}`,
			new Promise<number | undefined>((resolvePromise) => {
				client.publish(topic, JSON.stringify({ id: 'a', value: 'x' }), { qos: 1 }, (error) =>
					resolvePromise(error ? (error as any).code : 0)
				);
			})
		);
	}

	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, {
			config: { authentication: { authorizeLocal: false }, mqtt: { requireAuthentication: false } },
		});
		const httpURL = ctx.harper.httpURL;
		mqttURL = `${httpURL.replace(/^https?/, httpURL.startsWith('https') ? 'wss' : 'ws')}/mqtt`;
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('SUBACK: a v5 client with no username gets 0x87 and "Must login"', async () => {
		const client = await connect();
		try {
			const result = await subscribe(client, 'Guarded/#');
			strictEqual(result.code, NOT_AUTHORIZED);
			strictEqual(result.reasonString, 'Must login');
		} finally {
			await end(client);
		}
	});

	test('PUBACK: a v5 client with no username gets 0x87', async () => {
		const client = await connect();
		try {
			strictEqual(await publish(client, 'Guarded/a'), NOT_AUTHORIZED);
		} finally {
			await end(client);
		}
	});

	test('SUBACK: a v3.1.1 client with no username still gets 0x80', async () => {
		const client = await connect({ protocolVersion: 4 });
		try {
			strictEqual((await subscribe(client, 'Guarded/#')).code, UNSPECIFIED_ERROR);
		} finally {
			await end(client);
		}
	});

	const WRONG_PASSWORD = { username: 'nobody', password: 'wrong' };

	test('CONNACK: a v5 client with a wrong password gets 0x86', async () => {
		strictEqual(await refusedCode(WRONG_PASSWORD), BAD_CREDENTIALS);
	});

	test('CONNACK: a v3.1.1 client with a wrong password gets return code 4', async () => {
		strictEqual(await refusedCode({ ...WRONG_PASSWORD, protocolVersion: 4 }), BAD_CREDENTIALS_311);
	});

	test('CONNACK: a v5 client refused by authorizeClient with a 403 gets 0x87', async () => {
		strictEqual(await refusedCode({ clientId: 'denied-v5' }), NOT_AUTHORIZED);
	});

	test('CONNACK: a v3.1.1 client refused by authorizeClient with a 403 gets return code 5', async () => {
		strictEqual(await refusedCode({ clientId: 'denied-v311', protocolVersion: 4 }), NOT_AUTHORIZED_311);
	});

	test('control: an authenticated super user is granted the same topic', async () => {
		const client = await connect({ username: ctx.harper.admin.username, password: ctx.harper.admin.password });
		try {
			const result = await subscribe(client, 'Guarded/#');
			ok(result.code !== undefined && result.code < 0x80, `expected a grant, got ${result.code}`);
		} finally {
			await end(client);
		}
	});
});
