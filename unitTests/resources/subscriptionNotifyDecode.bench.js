/**
 * What one thread pays per commit to notify its subscribers, and what decoding a record costs, at three record
 * sizes. Every worker thread runs this same pass for every commit to a database it has a subscriber in, so a
 * cost here is paid once per thread. A manual run, not part of CI:
 *
 *   npm run build && npx mocha unitTests/resources/subscriptionNotifyDecode.bench.js
 *
 * The pass is measured apart from the writes: notification is held while SUBSCRIPTION_DECODE_BENCH_COMMITS
 * single-record commits land, then one sentinel commit releases it and the thread's CPU is read until the
 * sentinel's own subscriber hears it. A pass with no held commits is subtracted. Each held commit updates a
 * distinct record, so each is the record's current version when the pass reads it. The record cache is
 * cleared before the pass, as another thread's cache would not hold the new versions.
 *
 * Scenarios, per commit:
 * - otherTable: the database has a subscriber, on another table, so the pass reads every entry's header
 * - otherRecords: the table has subscribers, none of them to the written records
 * - record1 / record8: one or eight subscribers to each written record
 * - record1Filtered: one subscriber per record whose rowFilter passes half the records
 *
 * Decode, per record: decoder.decode of the stored bytes, getBinarySync (native read only), and
 * getEntry(uncachedRead) (native read and decode).
 *
 * SUBSCRIPTION_DECODE_BENCH_ROUNDS (default 5) rounds alternate the scenario order. SUBSCRIPTION_DECODE_BENCH_SIZES
 * and SUBSCRIPTION_DECODE_BENCH_SCENARIOS (comma-separated names) narrow the run, for a profile.
 * SUBSCRIPTION_DECODE_BENCH_OUT appends one JSON line per measurement.
 */
const assert = require('node:assert');
const { appendFileSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
require('#src/server/serverHelpers/serverUtilities');

const COMMITS = Number(process.env.SUBSCRIPTION_DECODE_BENCH_COMMITS ?? 2000);
const ROUNDS = Number(process.env.SUBSCRIPTION_DECODE_BENCH_ROUNDS ?? 5);
const DECODE_REPEATS = Number(process.env.SUBSCRIPTION_DECODE_BENCH_DECODE_REPEATS ?? 20);
const OUT = process.env.SUBSCRIPTION_DECODE_BENCH_OUT;
// readings per record, chosen so the stored record is about 100 B, 1 KB and 10 KB
const ALL_SIZES = { '100B': 3, '1KB': 47, '10KB': 491 };
const SIZES = Object.fromEntries(
	Object.entries(ALL_SIZES).filter(
		([label]) =>
			!process.env.SUBSCRIPTION_DECODE_BENCH_SIZES ||
			process.env.SUBSCRIPTION_DECODE_BENCH_SIZES.split(',').includes(label)
	)
);

function makeRecord(seq, readings) {
	return {
		seq,
		device: `device-${seq % 100}`,
		active: seq % 2 === 0,
		temperature: 20 + (seq % 50) / 10,
		readings: Array.from({ length: readings }, (_, i) => ({
			t: 1_700_000_000_000 + seq * 1000 + i,
			v: ((seq * 31 + i) % 1000) / 10,
			unit: i % 3 ? 'C' : 'F',
		})),
	};
}

const cpuMicros = (since) => {
	const usage = process.threadCpuUsage(since);
	return usage.user + usage.system;
};
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = sorted.length >> 1;
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

describe('per-commit subscription notify and record decode on one thread (bench)', function () {
	this.timeout(0);
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	it('measures the notify pass per commit and decode per record at three sizes', async () => {
		const Other = table({
			database: 'notifydecodebench',
			table: 'Other',
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		const targets = {};
		for (const label of Object.keys(SIZES)) {
			targets[label] = table({
				database: 'notifydecodebench',
				table: `Target${label}`,
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'seq' },
					{ name: 'device' },
					{ name: 'active' },
					{ name: 'temperature' },
					{ name: 'readings' },
				],
			});
		}
		const ids = Array.from({ length: COMMITS }, (_, i) => `rec-${String(i).padStart(5, '0')}`);
		const recordBytes = {};
		let seq = 0;
		for (const [label, T] of Object.entries(targets)) {
			for (const id of ids) await T.put(id, makeRecord(seq++, SIZES[label]));
			recordBytes[label] = Math.round(
				ids.reduce((sum, id) => sum + T.primaryStore.getBinarySync(id).length, 0) / ids.length
			);
		}
		await Other.put('sentinel', { n: 0 });

		let sentinelHeard;
		const sentinel = await Other.subscribe({ id: 'sentinel', omitCurrent: true });
		sentinel.on('data', () => sentinelHeard?.());
		const envs = sentinel.subscriptions.tables.envs;
		assert.ok(envs && envs.auditStore, 'the sentinel registered with its database');
		await new Promise((resolve) => setImmediate(resolve));

		let delivered = 0;
		const count = () => delivered++;
		const subscribeEach = async (T, keys, perKey, extra) => {
			const subscriptions = [];
			for (const id of keys) {
				for (let i = 0; i < perKey; i++) {
					const subscription = await T.subscribe({ id, omitCurrent: true, ...extra });
					subscription.on('data', count);
					subscriptions.push(subscription);
				}
			}
			await new Promise((resolve) => setImmediate(resolve));
			return subscriptions;
		};
		const idleIds = ids.map((id) => `idle-${id}`);
		const scenarios = {
			otherTable: async () => [],
			otherRecords: (T) => subscribeEach(T, idleIds, 1),
			record1: (T) => subscribeEach(T, ids, 1),
			record8: (T) => subscribeEach(T, ids, 8),
			record1Filtered: (T) => subscribeEach(T, ids, 1, { rowFilter: (record) => record.seq % 2 === 0 }),
		};

		/** Holds notification while `commits` records of T are written, then times the pass that delivers them. */
		const timePass = async (T, label, commits) => {
			envs.notifyScheduled = true;
			for (let i = 0; i < commits; i++) await T.put(ids[i], makeRecord(seq++, SIZES[label]));
			T.primaryStore.cache?.clear();
			global.gc?.();
			const heard = new Promise((resolve) => (sentinelHeard = resolve));
			delivered = 0;
			envs.notifyScheduled = false;
			const start = process.threadCpuUsage();
			const startWall = process.hrtime.bigint();
			await Other.put('sentinel', { n: seq++ });
			await heard;
			const cpu = cpuMicros(start);
			const wall = Number(process.hrtime.bigint() - startWall) / 1000;
			sentinelHeard = undefined;
			return { cpu, wall, delivered };
		};

		/** ns per record for one function over every id, repeated. */
		const timePerRecord = (fn) => {
			for (const id of ids) fn(id); // warm
			const start = process.threadCpuUsage();
			for (let r = 0; r < DECODE_REPEATS; r++) for (const id of ids) fn(id);
			return (cpuMicros(start) * 1000) / (DECODE_REPEATS * ids.length);
		};

		const results = [];
		const record = (row) => {
			results.push(row);
			if (OUT) appendFileSync(OUT, JSON.stringify(row) + '\n');
		};
		const scenarioNames = Object.keys(scenarios).filter(
			(name) =>
				!process.env.SUBSCRIPTION_DECODE_BENCH_SCENARIOS ||
				process.env.SUBSCRIPTION_DECODE_BENCH_SCENARIOS.split(',').includes(name)
		);
		const labels = Object.keys(SIZES);
		for (let round = 0; round < ROUNDS; round++) {
			const order = round % 2 ? [...scenarioNames].reverse() : scenarioNames;
			for (const label of round % 2 ? [...labels].reverse() : labels) {
				const T = targets[label];
				// the least of three empty passes: one can land on a collection or a flush
				let base = await timePass(T, label, 0);
				for (let i = 0; i < 2; i++) {
					const again = await timePass(T, label, 0);
					if (again.cpu < base.cpu) base = again;
				}
				for (const scenario of order) {
					const subscriptions = await scenarios[scenario](T);
					const pass = await timePass(T, label, COMMITS);
					const expected = { otherTable: 0, otherRecords: 0, record1: COMMITS, record8: 8 * COMMITS };
					if (expected[scenario] !== undefined) assert.strictEqual(pass.delivered, expected[scenario], scenario);
					for (const subscription of subscriptions) subscription.end();
					record({
						kind: 'notify',
						round,
						size: label,
						recordBytes: recordBytes[label],
						scenario,
						commits: COMMITS,
						delivered: pass.delivered,
						cpuNsPerCommit: Math.round(((pass.cpu - base.cpu) * 1000) / COMMITS),
						wallNsPerCommit: Math.round(((pass.wall - base.wall) * 1000) / COMMITS),
					});
				}
				const store = T.primaryStore;
				const stored = new Map(ids.map((id) => [id, Buffer.from(store.getBinarySync(id))]));
				record({
					kind: 'decode',
					round,
					size: label,
					recordBytes: recordBytes[label],
					decodeNs: Math.round(timePerRecord((id) => store.decoder.decode(stored.get(id)))),
					nativeReadNs: Math.round(timePerRecord((id) => store.getBinarySync(id))),
					readAndDecodeNs: Math.round(timePerRecord((id) => store.getEntry(id, { uncachedRead: true }))),
				});
			}
		}
		await sentinel.end();

		const summary = [];
		for (const label of labels) {
			const decodes = results.filter((row) => row.kind === 'decode' && row.size === label);
			const row = {
				size: label,
				recordBytes: recordBytes[label],
				decodeNs: median(decodes.map((r) => r.decodeNs)),
				nativeReadNs: median(decodes.map((r) => r.nativeReadNs)),
				readAndDecodeNs: median(decodes.map((r) => r.readAndDecodeNs)),
			};
			for (const scenario of scenarioNames) {
				const values = results
					.filter((r) => r.kind === 'notify' && r.size === label && r.scenario === scenario)
					.map((r) => r.cpuNsPerCommit);
				row[scenario] = `${median(values)} (${Math.min(...values)}–${Math.max(...values)})`;
			}
			summary.push(row);
		}
		console.log(`\nCPU ns per commit on the notifying thread, median (min–max) of ${ROUNDS} rounds`);
		console.table(summary);
	});
});
