/**
 * harper#2335 probe 2: a connection pinned to a not-yet-restarted worker.
 *
 * Connect N MQTT clients BEFORE deploying, so each is pinned to a pre-deploy worker, then
 * deploy_component{restart:true} and keep publishing on the held connections. Records
 * per-publish outcome, whether the client saw a DISCONNECT/close, and whether any publish
 * callback never settles (the client-visible hang from the QA finding).
 */
import { suite, test, before, after } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import mqtt from 'mqtt';
import { startHarper, teardownHarper, sendOperation, targz } from '@harperfast/integration-testing';

const PROJECT = 'qa2335b-app';
const TABLE = 'Qa2335bMsg';
const THREADS = 4;
const CLIENTS = 8;

async function buildPayload() {
	const dir = await mkdtemp(join(tmpdir(), 'qa2335b-'));
	try {
		await writeFile(join(dir, 'config.yaml'), 'graphqlSchema:\n  files: "*.graphql"\n');
		await writeFile(join(dir, 'schema.graphql'), `type ${TABLE} @table @export {\n\tid: ID @primaryKey\n\tvalue: String\n}\n`);
		return await targz(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function connectOnce(url, opts) {
	return new Promise((resolve, reject) => {
		const client = mqtt.connect(url, opts);
		const timer = setTimeout(() => { client.end(true); reject(new Error('connect timeout')); }, 10000);
		client.on('connect', () => { clearTimeout(timer); resolve(client); });
		client.on('error', (err) => { clearTimeout(timer); client.end(true); reject(err); });
	});
}

suite('harper#2335 held connection across deploy restart', (ctx) => {
	before(async () => {
		await startHarper(ctx, { config: { threads: { count: THREADS }, logging: { level: 'debug' } } });
	});
	after(async () => { await teardownHarper(ctx); });

	test('publishes on held connections during the rolling restart', async () => {
		const { httpURL, admin } = ctx.harper;
		const url = httpURL.replace(/^http/, 'ws') + '/mqtt';
		const opts = { username: admin.username, password: admin.password, protocolVersion: 5, clean: true, reconnectPeriod: 0, connectTimeout: 8000 };

		const events = [];
		const clients = [];
		for (let i = 0; i < CLIENTS; i++) {
			const c = await connectOnce(url, { ...opts, clientId: `qa2335b-${i}` });
			c.on('close', () => events.push({ t: Date.now(), client: i, event: 'close' }));
			c.on('disconnect', (packet) => events.push({ t: Date.now(), client: i, event: 'disconnect', reasonCode: packet?.reasonCode }));
			c.on('error', (err) => events.push({ t: Date.now(), client: i, event: 'error', msg: err.message }));
			clients.push(c);
		}

		const deployPromise = sendOperation(ctx.harper, {
			operation: 'deploy_component', project: PROJECT, payload: await buildPayload(), restart: true,
		});
		const t0 = Date.now();
		const results = [];
		let seq = 0;

		const pump = clients.map((client, i) => (async () => {
			while (Date.now() - t0 < 25000) {
				const tag = `${i}-${seq++}`;
				const at = Date.now() - t0;
				const outcome = await new Promise((resolve) => {
					const timer = setTimeout(() => resolve('NEVER-SETTLED'), 10000);
					try {
						client.publish(`${TABLE}/p-${tag}`, JSON.stringify({ value: 'x' }), { qos: 1 }, (err) => {
							clearTimeout(timer);
							resolve(err ? 'ERR: ' + err.message : 'OK');
						});
					} catch (err) { clearTimeout(timer); resolve('THROW: ' + err.message); }
				});
				results.push({ at, tag, outcome });
				await sleep(400);
			}
		})());
		await Promise.all(pump);
		await deployPromise.catch((e) => console.log('deploy error', e.message));

		const counts = {};
		for (const r of results) counts[r.outcome.split(':')[0]] = (counts[r.outcome.split(':')[0]] ?? 0) + 1;
		console.log('\n=== outcome counts ===', JSON.stringify(counts));
		for (const r of results.filter((r) => r.outcome !== 'OK').slice(0, 40)) console.log(`  +${r.at}ms ${r.tag} ${r.outcome}`);
		console.log('=== client events ===');
		for (const e of events) console.log(`  +${e.t - t0}ms client ${e.client} ${e.event} ${e.reasonCode ?? e.msg ?? ''}`);
	});
});
