/**
 * Benchmark: CPU per published message spent delivering it to N in-process MQTT sessions subscribed to wildcard
 * topics, against the same publishes without those sessions. Both arms subscribe one more session to an exact
 * topic, published to last, so each measures the same notify passes and ends once they have dispatched everything.
 * CPU is this thread's where Node reports it (process.threadCpuUsage), else the process's.
 * Run via: npm run build && npx mocha unitTests/resources/mqttWildcardSubscription.bench.js
 * MQTT_BENCH_SESSIONS (comma list), MQTT_BENCH_MESSAGES, MQTT_BENCH_OUT (a file that gets one JSON row per
 * measurement, for A/B runs across builds) and MQTT_BENCH_TOPIC, what session i subscribes to and what is published:
 * - plain (default): `site/+/m<i>`; every message matches one session;
 * - hash: `site/+/m<i>/#`, published one level deeper; every message matches one session;
 * - shapes: a pattern of its own shape under `tenantA/` (64 shapes, then repeating), ending `s<i>`; every message
 *   matches one session;
 * - unrelated: the shapes of `shapes`, with messages published under `tenantB/`, which no session matches;
 * - leading: `+/d0/l0/l1/l2/l3/l4/l5/nomatch<i>`, as deep as the messages, which it never matches;
 * - prefixes: `p<i>/+/x`, each under a prefix of its own, with messages published under `tenantB/`.
 */
const { setupTestDBPath } = require('../testUtils.js');
const { table } = require('#src/resources/databases');
const Resources = require('#src/resources/Resources');
const { getSession } = require('#src/server/DurableSubscriptionsSession');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor.js');
require('#src/server/serverHelpers/serverUtilities');

const MESSAGES = Number(process.env.MQTT_BENCH_MESSAGES ?? 5000);
const BATCH = 100;
const DEVICES = 50;
const TOPIC = process.env.MQTT_BENCH_TOPIC ?? 'plain';
const MATCHES_NONE = TOPIC === 'unrelated' || TOPIC === 'leading' || TOPIC === 'prefixes';
const DEFAULT_SESSIONS =
	{ shapes: '1,8,64', unrelated: '1,8,64', leading: '1,100,1000', prefixes: '1,100,1000' }[TOPIC] ?? '1,100,1000,10000';
const SESSION_COUNTS = (process.env.MQTT_BENCH_SESSIONS ?? DEFAULT_SESSIONS).split(',').map(Number);
const user = { username: 'mqtt-bench', role: { permission: { super_user: true } } };
const cpuUsage = (previous) => process.threadCpuUsage?.(previous) ?? process.cpuUsage(previous);

function shapeLevels(i) {
	const levels = [];
	for (let bit = 0; bit < 6; bit++) levels.push(i & (1 << bit) ? '+' : `l${bit}`);
	return levels.join('/');
}
function topicFor(i) {
	switch (TOPIC) {
		case 'hash':
			return `site/+/m${i}/#`;
		case 'shapes':
		case 'unrelated':
			return `tenantA/+/${shapeLevels(i)}/s${i}`;
		case 'leading':
			return `+/d0/l0/l1/l2/l3/l4/l5/nomatch${i}`;
		case 'prefixes':
			return `p${i}/+/x`;
		default:
			return `site/+/m${i}`;
	}
}
function idFor(sequence, sessionCount) {
	const device = 'd' + (sequence % DEVICES);
	const metric = sequence % sessionCount;
	switch (TOPIC) {
		case 'hash':
			return `site/${device}/m${metric}/value`;
		case 'shapes':
			return `tenantA/${device}/l0/l1/l2/l3/l4/l5/s${metric}`;
		case 'unrelated':
		case 'leading':
		case 'prefixes':
			return `tenantB/${device}/l0/l1/l2/l3/l4/l5/s${metric}`;
		default:
			return `site/${device}/m${metric}`;
	}
}

describe(`MQTT wildcard subscription delivery cost (${TOPIC})`, function () {
	let tableCount = 0;
	const results = [];
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		if (!Resources.resources) Resources.resetResources();
	});
	after(() => {
		console.table(results);
	});

	function createSensorTable() {
		const name = `Sensor${++tableCount}`;
		const Sensor = table({
			database: 'mqttbench',
			table: name,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'value' }],
		});
		Resources.resources.set(name, Sensor, { mqtt: true });
		return { Sensor, name };
	}

	async function publishReadings(Sensor, sessionCount) {
		for (let sequence = 0; sequence < MESSAGES;) {
			await transaction({}, async (context) => {
				for (let i = 0; i < BATCH && sequence < MESSAGES; i++, sequence++) {
					Sensor.publish(idFor(sequence, sessionCount), { value: sequence }, context);
				}
			});
		}
	}

	async function subscribe(name, topic, listener) {
		const session = await getSession({ clientId: `bench-${tableCount}-${topic}`, user, clean: true });
		session.listener = listener;
		await session.addSubscription({ topic: `${name}/${topic}`, qos: 0 }, false);
		return session;
	}

	async function measure(sessionCount, subscribed) {
		const { Sensor, name } = createSensorTable();
		let delivered = 0;
		let drained = false;
		const sessions = [await subscribe(name, 'sentinel', () => (drained = true))];
		for (let i = 0; subscribed && i < sessionCount; i++) {
			sessions.push(await subscribe(name, topicFor(i), () => delivered++));
		}
		const cpuBefore = cpuUsage();
		await publishReadings(Sensor, sessionCount);
		await Sensor.publish('sentinel', { value: 0 });
		await waitFor(() => drained && (!subscribed || MATCHES_NONE || delivered >= MESSAGES), 600000, 1);
		const cpu = cpuUsage(cpuBefore);
		for (const session of sessions) for (const subscription of session.subscriptions) subscription.end();
		return (cpu.user + cpu.system) / MESSAGES;
	}

	it('warms up', async () => {
		await measure(1, false);
		await measure(1, true);
	});

	for (const sessionCount of SESSION_COUNTS) {
		it(`${sessionCount} wildcard sessions`, async () => {
			const baseline = await measure(sessionCount, false);
			const perMessage = await measure(sessionCount, true);
			const row = {
				'sessions': sessionCount,
				'µs/message': +perMessage.toFixed(2),
				'no-subscriber µs/message': +baseline.toFixed(2),
				'delivery µs/message': +(perMessage - baseline).toFixed(2),
			};
			results.push(row);
			if (process.env.MQTT_BENCH_OUT) {
				require('node:fs').appendFileSync(process.env.MQTT_BENCH_OUT, JSON.stringify(row) + '\n');
			}
		});
	}
});
