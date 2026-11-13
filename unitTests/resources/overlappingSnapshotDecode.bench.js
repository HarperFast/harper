/**
 * How much decoding repeats when snapshot scans of one table overlap. A collection subscription without
 * omitCurrent scans the table's current rows; while three or more scans overlap, sharedVersionValue hands them
 * one value object per version, but only after each scan's range iterator has decoded its own copy. This bench
 * runs 1 scan and 8 overlapping scans of OVERLAP_BENCH_ROWS rows (default 10,000) and reports CPU per row per
 * scan, how many times each row was decoded, and the per-row parts a scan is made of. A manual run, not part of
 * CI:
 *
 *   npm run build && npx mocha unitTests/resources/overlappingSnapshotDecode.bench.js
 *
 * The record cache is cleared before each run, as a storm of reconnecting clients meets rows nobody has read.
 *
 * Parts, ns per row, from bare iterations of the primary store:
 * - keysOnly: getRange({ values: false }), the native step and key decode
 * - withValues: getRange as the snapshot scan calls it, which decodes every value
 * - decode: RecordEncoder.decode of the stored bytes alone
 * - copy: Buffer.from of the stored bytes, what holding a row's bytes past the iterator's next step would cost
 *
 * OVERLAP_BENCH_ROUNDS (default 5) rounds alternate the order; OVERLAP_BENCH_SIZES narrows the sizes;
 * OVERLAP_BENCH_OUT appends JSON lines.
 */
const assert = require('node:assert');
const { appendFileSync } = require('node:fs');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { setAnalyticsEnabled, checkAnalyticsEnabled } = require('#src/resources/analytics/write');
require('#src/server/serverHelpers/serverUtilities');

const ROWS = Number(process.env.OVERLAP_BENCH_ROWS ?? 10_000);
const ROUNDS = Number(process.env.OVERLAP_BENCH_ROUNDS ?? 5);
const OUT = process.env.OVERLAP_BENCH_OUT;
const ALL_SIZES = { '100B': 3, '1KB': 47, '10KB': 491 };
const SIZES = Object.fromEntries(
	Object.entries(ALL_SIZES).filter(
		([label]) => !process.env.OVERLAP_BENCH_SIZES || process.env.OVERLAP_BENCH_SIZES.split(',').includes(label)
	)
);
const SCAN_COUNTS = [1, 8];

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

describe('decoding repeated by overlapping snapshot scans (bench)', function () {
	this.timeout(0);
	let analyticsWereEnabled;
	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		// the analytics timer's first flush opens its database, tens of ms that would land in whichever scan it fires in
		analyticsWereEnabled = checkAnalyticsEnabled(false);
		setAnalyticsEnabled(false);
	});
	after(() => {
		if (analyticsWereEnabled !== undefined) setAnalyticsEnabled(analyticsWereEnabled);
	});

	it(`scans ${ROWS} rows once and eight times at once`, async () => {
		const tables = {};
		let seq = 0;
		for (const [label, readings] of Object.entries(SIZES)) {
			const T = table({
				database: 'overlapdecodebench',
				table: `Overlap${label}`,
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
			for (let i = 0; i < ROWS; i += 500) {
				const writes = [];
				for (let j = i; j < Math.min(i + 500, ROWS); j++)
					writes.push(T.put(`row-${String(j).padStart(6, '0')}`, makeRecord(seq++, readings)));
				await Promise.all(writes);
			}
			tables[label] = T;
		}

		/** Runs `scans` overlapping snapshot subscriptions to completion; CPU of this thread, and decodes per row. */
		const runScans = async (T, scans, countDecodes) => {
			const store = T.primaryStore;
			store.cache?.clear();
			global.gc?.();
			const encoder = store.decoder;
			let decodes = 0;
			const decode = encoder.decode;
			// a scan that defers a value (deferValues) decodes its metadata now and its value only on demand
			const decodeDeferred = encoder.decodeDeferred;
			if (countDecodes) {
				encoder.decode = function (...args) {
					if (!this.deferValues) decodes++;
					return decode.apply(this, args);
				};
				if (decodeDeferred)
					encoder.decodeDeferred = function (...args) {
						decodes++;
						return decodeDeferred.apply(this, args);
					};
			}
			const subscriptions = [];
			const finished = [];
			const start = process.threadCpuUsage();
			try {
				for (let s = 0; s < scans; s++) {
					let rows = 0;
					let resolve;
					finished.push(new Promise((r) => (resolve = r)));
					subscriptions.push(
						T.subscribe({
							isCollection: true,
							listener: (event) => {
								if (event.fromScan && ++rows === ROWS) resolve();
							},
						})
					);
				}
				await Promise.all(subscriptions);
				await Promise.all(finished);
			} finally {
				// newest first, so each delete rolls back the shape it added rather than leaving the encoder in
				// dictionary mode, which would slow every later decode
				if (countDecodes) {
					delete encoder.decodeDeferred;
					delete encoder.decode;
				}
			}
			const cpu = cpuMicros(start);
			for (const subscription of await Promise.all(subscriptions)) subscription.end();
			return { nsPerRowScan: Math.round((cpu * 1000) / (ROWS * scans)), decodesPerRow: decodes / ROWS };
		};

		const perRow = (fn) => {
			const start = process.threadCpuUsage();
			const rows = fn();
			assert.strictEqual(rows, ROWS);
			return Math.round((cpuMicros(start) * 1000) / ROWS);
		};
		const parts = (T) => {
			const store = T.primaryStore;
			const stored = [];
			for (const { value } of store.getRange({ start: false, values: true, versions: true, snapshot: false })) {
				assert.ok(value);
			}
			for (const key of store.getKeys({ start: false, snapshot: false }))
				stored.push(Buffer.from(store.getBinarySync(key)));
			const count = (iterable) => {
				let n = 0;
				for (const _ of iterable) n++;
				return n;
			};
			return {
				keysOnly: perRow(() => count(store.getRange({ start: false, values: false, snapshot: false }))),
				withValues: perRow(() => count(store.getRange({ start: false, versions: true, snapshot: false }))),
				decode: perRow(() => {
					for (const bytes of stored) encoder(store).decode(bytes);
					return stored.length;
				}),
				copy: perRow(() => {
					for (const bytes of stored) Buffer.from(bytes);
					return stored.length;
				}),
			};
		};
		const encoder = (store) => store.decoder;

		const results = [];
		const record = (row) => {
			results.push(row);
			if (OUT) appendFileSync(OUT, JSON.stringify(row) + '\n');
		};
		const labels = Object.keys(SIZES);
		for (let round = 0; round < ROUNDS; round++) {
			for (const label of round % 2 ? [...labels].reverse() : labels) {
				const T = tables[label];
				for (const scans of round % 2 ? [...SCAN_COUNTS].reverse() : SCAN_COUNTS) {
					record({ kind: 'scan', round, size: label, scans, ...(await runScans(T, scans, false)) });
				}
				global.gc?.();
				record({ kind: 'parts', round, size: label, ...parts(T) });
			}
		}
		for (const label of labels) {
			// once, after the timed rounds, with each decode counted
			for (const scans of SCAN_COUNTS) {
				const { decodesPerRow } = await runScans(tables[label], scans, true);
				record({ kind: 'decodes', size: label, scans, decodesPerRow });
			}
		}

		const summarize = (values) => `${median(values)} (${Math.min(...values)}–${Math.max(...values)})`;
		const summary = labels.map((label) => {
			const row = { size: label };
			for (const scans of SCAN_COUNTS) {
				const scanRows = results.filter((r) => r.kind === 'scan' && r.size === label && r.scans === scans);
				row[`${scans} scan ns/row/scan`] = summarize(scanRows.map((r) => r.nsPerRowScan));
				row[`${scans} scan decodes/row`] = results.find(
					(r) => r.kind === 'decodes' && r.size === label && r.scans === scans
				).decodesPerRow;
			}
			const partRows = results.filter((r) => r.kind === 'parts' && r.size === label);
			for (const part of ['keysOnly', 'withValues', 'decode', 'copy'])
				row[part] = summarize(partRows.map((r) => r[part]));
			return row;
		});
		console.log(`\nCPU ns, median (min–max) of ${ROUNDS} rounds, ${ROWS} rows`);
		console.table(summary);
	});
});
