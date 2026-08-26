/**
 * harper#2335 repro probe: after deploy_component{restart:true}, is the component's MQTT topic
 * resource registered on every http worker?
 *
 * Deploys a component whose schema.graphql exports a table, restarts the http workers, then
 * repeatedly opens fresh MQTT-over-WS connections (each lands on whichever worker accept()s it)
 * and publishes QoS1. Records per-attempt outcome + elapsed time so we can tell
 * "eventually consistent" from "broken until restart".
 */
import { suite, test, before, after } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import mqtt from 'mqtt';
import { startHarper, teardownHarper, sendOperation, targz } from '@harperfast/integration-testing';

const PROJECT = 'qa2335-app';
const TABLE = 'Qa2335Msg';
const THREADS = 4;

async function buildPayload() {
	const dir = await mkdtemp(join(tmpdir(), 'qa2335-'));
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

function connectOnce(url, opts) {
	return new Promise((resolve, reject) => {
		const client = mqtt.connect(url, opts);
		const timer = setTimeout(() => {
			client.end(true);
			reject(new Error('connect timeout'));
		}, 10000);
		client.on('connect', () => {
			clearTimeout(timer);
			resolve(client);
		});
		client.on('error', (err) => {
			clearTimeout(timer);
			client.end(true);
			reject(err);
		});
	});
}

suite('harper#2335 per-worker MQTT resource registration', (ctx) => {
	before(async () => {
		await startHarper(ctx, { config: { threads: { count: THREADS }, logging: { level: 'debug' } } });
	});
	after(async () => {
		await teardownHarper(ctx);
	});

	test('probe publishes across many fresh connections after deploy+restart', async () => {
		const { httpURL, admin } = ctx.harper;
		const url = httpURL.replace(/^http/, 'ws') + '/mqtt';
		const opts = {
			username: admin.username,
			password: admin.password,
			protocolVersion: 5,
			clean: true,
			reconnectPeriod: 0,
			connectTimeout: 8000,
		};

		const deployResult = await sendOperation(ctx.harper, {
			operation: 'deploy_component',
			project: PROJECT,
			payload: await buildPayload(),
			restart: true,
		});
		console.log('deploy:', deployResult?.message ?? JSON.stringify(deployResult));
		const t0 = Date.now();

		const results = [];
		const deadline = t0 + 45000;
		let round = 0;
		const FANOUT = 6;
		while (Date.now() < deadline) {
			round++;
			const at = Date.now() - t0;
			await Promise.all(
				Array.from({ length: FANOUT }, async (_, i) => {
					const tag = `${round}-${i}`;
					let client;
					try {
						client = await connectOnce(url, { ...opts, clientId: `qa2335-${tag}-${Math.random().toString(36).slice(2)}` });
					} catch (err) {
						results.push({ round, at, tag, phase: 'connect', error: err.message });
						return;
					}
					try {
						await new Promise((resolve, reject) => {
							const timer = setTimeout(() => reject(new Error('publish never settled')), 8000);
							client.publish(`${TABLE}/probe-${tag}`, JSON.stringify({ value: 'x' }), { qos: 1 }, (err) => {
								clearTimeout(timer);
								err ? reject(err) : resolve();
							});
						});
						results.push({ round, at, tag, phase: 'publish', ok: true });
					} catch (err) {
						results.push({ round, at, tag, phase: 'publish', error: err.message });
					} finally {
						client.end(true);
					}
				})
			);
			await sleep(300);
		}

		const bad = results.filter((r) => r.error);
		console.log(`\n=== ${results.length} attempts, ${bad.length} failures ===`);
		for (const r of results) {
			console.log(`  +${String(r.at).padStart(6)}ms ${r.tag} ${r.phase} ${r.ok ? 'OK' : 'FAIL: ' + r.error}`);
		}
	});
});
