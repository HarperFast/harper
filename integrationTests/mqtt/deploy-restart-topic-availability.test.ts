/**
 * harper#2335: after `deploy_component { restart: true }`, the deployed component's MQTT topic must
 * be usable on every worker — and a worker that is going away must tell its clients so.
 *
 * The regression: `deploy_component` fired the worker restart without awaiting it and reported
 * success immediately. On SO_REUSEPORT platforms the not-yet-replaced workers keep accepting
 * connections for the whole rolling restart, so a client that publishes as soon as the deploy
 * succeeds lands (per connection, at random) on a worker still running the pre-deploy component
 * set and its publish is refused. Measured on Linux against the pre-fix build: 38 of 870 publishes
 * refused over the first ~3s, mixed with successes in the same round.
 *
 * Three things are asserted here:
 *  1. every publish succeeds once the deploy operation has returned (the restart is awaited);
 *  2. a publish to a topic no resource handles is refused with reason code 0x90 "Topic Name
 *     invalid" and a reason string, not a bare 0x80 "Unspecified error";
 *  3. a worker restart sends MQTT v5 clients DISCONNECT 0x8B "Server shutting down" instead of
 *     silently dropping the socket.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import mqtt, { type MqttClient } from 'mqtt';
import {
	startHarper,
	teardownHarper,
	sendOperation,
	targz,
	type ContextWithHarper,
} from '@harperfast/integration-testing';

const PROJECT = 'mqtt-deploy-restart-app';
const TABLE = 'DeployRestartMsg';
const THREADS = 4;
/** Fresh connections per round: each one is accepted by whichever worker wins it, so a fan-out
 * this size reliably covers every worker in the pool. */
const FANOUT = 8;
const ROUNDS = 4;

/** MQTT v5 reason codes. */
const TOPIC_NAME_INVALID = 0x90;
const SERVER_SHUTTING_DOWN = 0x8b;

async function buildPayload(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'mqtt-deploy-restart-'));
	try {
		await writeFile(join(dir, 'config.yaml'), 'graphqlSchema:\n  files: "*.graphql"\n');
		await writeFile(
			join(dir, 'schema.graphql'),
			`type ${TABLE} @table @export {\n\tid: ID @primaryKey\n\tvalue: String\n}\n`
		);
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function connect(url: string, clientId: string, admin: { username: string; password: string }): Promise<MqttClient> {
	return new Promise((resolve, reject) => {
		const client = mqtt.connect(url, {
			clientId,
			username: admin.username,
			password: admin.password,
			protocolVersion: 5,
			clean: true,
			reconnectPeriod: 0,
			connectTimeout: 10_000,
		});
		const timer = setTimeout(() => {
			client.end(true);
			reject(new Error('MQTT connect timed out'));
		}, 15_000);
		client.on('connect', () => {
			clearTimeout(timer);
			resolve(client);
		});
		client.on('error', (error) => {
			clearTimeout(timer);
			client.end(true);
			reject(error);
		});
	});
}

/**
 * Connect, retrying a refused connection for up to `timeoutMs`. Only the first test asserts on
 * connection availability; the others are about what the server answers once connected, so they
 * wait out any restart still in progress rather than failing for the wrong reason.
 */
async function connectWhenAvailable(
	url: string,
	clientId: string,
	admin: { username: string; password: string },
	timeoutMs = 30_000
): Promise<MqttClient> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await connect(url, clientId, admin);
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
}

/** Resolves to null on success, or the publish error (which carries the v5 reason code). */
function publish(client: MqttClient, topic: string): Promise<any> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`publish to ${topic} never settled`)), 15_000);
		client.publish(topic, JSON.stringify({ value: 'x' }), { qos: 1 }, (error) => {
			clearTimeout(timer);
			resolve(error ?? null);
		});
	});
}

suite('MQTT topic availability across a deploy restart (harper#2335)', (ctx: ContextWithHarper) => {
	let url: string;

	before(async () => {
		await startHarper(ctx, { config: { threads: { count: THREADS } } });
		url = ctx.harper.httpURL.replace(/^http/, 'ws') + '/mqtt';
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('the deployed topic is live on every worker as soon as the deploy returns', async () => {
		const response = await sendOperation(ctx.harper, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(),
			restart: true,
		});
		ok(
			response.message?.includes(`Successfully deployed: ${PROJECT}`),
			`unexpected deploy message: ${response.message}`
		);

		const failures: string[] = [];
		for (let round = 0; round < ROUNDS; round++) {
			await Promise.all(
				Array.from({ length: FANOUT }, async (_, i) => {
					const tag = `${round}-${i}`;
					let client: MqttClient;
					try {
						client = await connect(url, `deploy-restart-${tag}`, ctx.harper.admin);
					} catch (error: any) {
						failures.push(`connect ${tag}: ${error.message}`);
						return;
					}
					try {
						const error = await publish(client, `${TABLE}/probe-${tag}`);
						if (error) failures.push(`publish ${tag}: ${error.message} (reason ${error.code})`);
					} catch (error: any) {
						failures.push(`publish ${tag}: ${error.message}`);
					} finally {
						client.end(true);
					}
				})
			);
		}
		strictEqual(failures.length, 0, `publishes failed after the deploy returned:\n  ${failures.join('\n  ')}`);
	});

	test('a publish to an unhandled topic is refused as "Topic Name invalid", not "Unspecified error"', async () => {
		const client = await connectWhenAvailable(url, 'deploy-restart-unknown-topic', ctx.harper.admin);
		try {
			const error = await publish(client, 'NoSuchTopicResource/anything');
			ok(error, 'expected the publish to an unhandled topic to be refused');
			strictEqual(error.code, TOPIC_NAME_INVALID, `expected reason code 0x90, got ${error.code}: ${error.message}`);
		} finally {
			client.end(true);
		}
	});

	test('a worker restart disconnects MQTT clients with "Server shutting down"', async () => {
		const client = await connectWhenAvailable(url, 'deploy-restart-shutdown-notice', ctx.harper.admin);
		try {
			const disconnected = new Promise<any>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('no DISCONNECT received before the socket closed')), 60_000);
				client.on('disconnect', (packet) => {
					clearTimeout(timer);
					resolve(packet);
				});
			});
			await sendOperation(ctx.harper, { operation: 'restart_service', service: 'http' });
			const packet = await disconnected;
			strictEqual(packet.reasonCode, SERVER_SHUTTING_DOWN, `unexpected DISCONNECT reason ${packet.reasonCode}`);
		} finally {
			client.end(true);
		}
	});
});
