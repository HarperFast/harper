// Integrated ingest benchmark for the file-primary HNSW derived index. Excluded from
// `test:unit:resources` by its `.bench.js` name; run it directly:
//
//   HOME=<isolated> npx mocha unitTests/resources/hnswDerivedIngest.bench.js
//
// The meter wraps whole backend methods: `applyDerivedValue` includes the vector hash and the
// RocksDB mapping writes as well as the native insert, and `flushDerived` includes publishing
// those mappings as well as the msync. It therefore bounds the backend's share, and does not
// separate native from JS inside it — the isolated package numbers do that.
//
// The serialized case awaits full drain between writes, so it measures the cost of one isolated
// write, not what a flush cadence could amortize. The repeated-key case counts distinct keys
// across the whole run, not within one delivery window.
require('../testUtils');
const assert = require('node:assert');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor');
const { table } = require('#src/resources/databases');
const { getPlaneBinding } = require('#src/resources/indexes/hnswPlaneBinding');
const { DERIVED_INDEX_CURSOR_KEY } = require('#src/resources/indexes/hnswDerivedIndex');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

const DIMS = Number(process.env.BENCH_DIMS ?? 384);
const SEED = Number(process.env.BENCH_SEED ?? 1000);
const BURST = Number(process.env.BENCH_BURST ?? 2000);
const TRICKLE = Number(process.env.BENCH_TRICKLE ?? 40);
const HOT_KEYS = Number(process.env.BENCH_HOT_KEYS ?? 50);
const HOT_ROUNDS = Number(process.env.BENCH_HOT_ROUNDS ?? 20);
const DB = 'vector-ingest-bench';

let seedState = 42;
function rand() {
	seedState = (seedState * 1103515245 + 12345) % 2147483648;
	return seedState / 2147483648;
}
function makeVector() {
	const vector = new Array(DIMS);
	for (let i = 0; i < DIMS; i++) vector[i] = rand() * 2 - 1;
	return vector;
}

function percentile(samples, fraction) {
	if (samples.length === 0) return 0;
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

describe('HNSW file-primary ingest cost', function () {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return;
	if (!getPlaneBinding()) {
		it.skip('skipped: @harperfast/hnsw native module is unavailable', () => {});
		return;
	}
	this.timeout(20 * 60_000);
	let Bench;
	const meter = { applyCount: 0, applyMs: 0, flushCount: 0, flushMs: 0 };

	function customIndex() {
		return Bench.indices.vector.customIndex;
	}

	function instrument() {
		const index = customIndex();
		const apply = index.applyDerivedValue.bind(index);
		const flush = index.flushDerived.bind(index);
		index.applyDerivedValue = (key, vector, version) => {
			const started = process.hrtime.bigint();
			try {
				return apply(key, vector, version);
			} finally {
				meter.applyMs += Number(process.hrtime.bigint() - started) / 1e6;
				meter.applyCount++;
			}
		};
		// flushDerived awaits the native barrier, so this spans an await and charges anything the
		// loop ran meanwhile to the backend. It is an upper bound on barrier cost, and the reason
		// the reported backend share is printed as a range with applyMs — which is synchronous and
		// exact — as its floor.
		index.flushDerived = async (watermark) => {
			const started = process.hrtime.bigint();
			try {
				return await flush(watermark);
			} finally {
				meter.flushMs += Number(process.hrtime.bigint() - started) / 1e6;
				meter.flushCount++;
			}
		};
	}

	function resetMeter() {
		meter.applyCount = 0;
		meter.applyMs = 0;
		meter.flushCount = 0;
		meter.flushMs = 0;
	}

	// Scanning the audit log to find the tail costs more than the drain being measured, so callers
	// read the tail before starting a clock and pass it to drained(), which only polls cursors.
	function auditTails() {
		const tails = [];
		for (const logName of Bench.auditStore.rootStore.listLogs()) {
			let latest;
			for (const entry of Bench.auditStore.getRange({ start: 0, log: logName }))
				if (entry.endTxn) latest = entry.txnLogKey;
			if (latest !== undefined) tails.push([logName, latest]);
		}
		return tails;
	}

	const POLL_MS = 1;

	async function drained(tails = auditTails()) {
		return waitFor(
			() =>
				tails.every(
					([logName, latest]) => Bench.indices.vector.getSync(DERIVED_INDEX_CURSOR_KEY)?.logs?.[logName] === latest
				),
			{ timeout: 15 * 60_000, interval: POLL_MS, message: 'derived index did not drain' }
		);
	}

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Bench = table({
			table: 'IngestBench',
			database: DB,
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{
					name: 'vector',
					indexed: { type: 'HNSW', nativePlane: true, efConstruction: 200 },
					type: 'Array',
				},
			],
		});
		await Bench.indexingOperation;
		await Bench.put(0, { vector: makeVector() });
		await drained();
		instrument();
		// Seed a graph large enough that insert cost reflects a populated index rather than
		// the near-empty one a fresh table would measure.
		for (let id = 1; id <= SEED; id++) await Bench.put(id, { vector: makeVector() });
		await drained();
	});

	it('burst ingest: foreground cost, drain cost, and event-loop occupancy', async () => {
		resetMeter();
		const loop = monitorEventLoopDelay({ resolution: 1 });
		const putSamples = [];
		loop.enable();
		const startedWrites = process.hrtime.bigint();
		for (let id = SEED + 1; id <= SEED + BURST; id++) {
			const started = process.hrtime.bigint();
			await Bench.put(id, { vector: makeVector() });
			putSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
		}
		const writeMs = Number(process.hrtime.bigint() - startedWrites) / 1e6;
		loop.disable();
		const writeLoopMax = loop.max / 1e6;
		const writeLoopP99 = loop.percentile(99) / 1e6;
		// Read the tail before the drain clock starts: scanning the retained log costs more than
		// the drain, and inside the window it would be charged to the runtime.
		const tails = auditTails();
		loop.reset();
		loop.enable();
		const startedDrain = process.hrtime.bigint();
		await drained(tails);
		const drainMs = Number(process.hrtime.bigint() - startedDrain) / 1e6;
		const totalMs = writeMs + drainMs;
		loop.disable();

		console.log(`\n== burst ${BURST} puts, dims=${DIMS}, graph≈${SEED + BURST} ==`);
		console.log(
			`  foreground put:      ${(writeMs / BURST).toFixed(3)} ms/put  (${Math.round(BURST / (writeMs / 1000))}/s)`
		);
		console.log(
			`  put p50/p99:         ${percentile(putSamples, 0.5).toFixed(3)} / ${percentile(putSamples, 0.99).toFixed(3)} ms`
		);
		console.log(`  write+drain wall:    ${totalMs.toFixed(0)} ms  (${Math.round(BURST / (totalMs / 1000))} indexed/s)`);
		console.log(
			`  applyDerivedValue:   ${meter.applyCount} calls, ${meter.applyMs.toFixed(0)} ms total, ${(meter.applyMs / Math.max(1, meter.applyCount)).toFixed(3)} ms/call`
		);
		console.log(
			`  flushDerived:        ${meter.flushCount} calls, ${meter.flushMs.toFixed(0)} ms total, ${(meter.flushMs / Math.max(1, meter.flushCount)).toFixed(3)} ms/call`
		);
		console.log(
			`  flush share of drain:${((meter.flushMs / Math.max(1, meter.applyMs + meter.flushMs)) * 100).toFixed(1)} %`
		);
		console.log(
			`  backend share of wall:${((meter.applyMs / Math.max(1, totalMs)) * 100).toFixed(1)}–${(((meter.applyMs + meter.flushMs) / Math.max(1, totalMs)) * 100).toFixed(1)} % of ${totalMs.toFixed(0)} ms (floor = synchronous apply ${meter.applyMs.toFixed(0)} ms; ceiling adds the barrier's ${meter.flushMs.toFixed(0)} ms, timed across an await)`
		);
		console.log(`  loop max/p99 writing:${writeLoopMax.toFixed(1)} / ${writeLoopP99.toFixed(1)} ms`);
		console.log(
			`  loop max/p99 draining:${(loop.max / 1e6).toFixed(1)} / ${(loop.percentile(99) / 1e6).toFixed(1)} ms`
		);
		assert.ok(meter.applyCount >= BURST);
	});

	it('serialized writes: freshness cost of one isolated write', async () => {
		resetMeter();
		const base = SEED + BURST + 1;
		for (let n = 0; n < TRICKLE; n++) {
			await Bench.put(base + n, { vector: makeVector() });
			await drained();
		}

		// The wall clock here would carry a retained-log scan and a poll interval per record, both
		// larger than the work; the meter is what this case is for.
		console.log(`\n== serialized ${TRICKLE} puts, full drain between each ==`);
		console.log(`  indexing work per record: ${((meter.applyMs + meter.flushMs) / TRICKLE).toFixed(2)} ms`);
		console.log(
			`  applyDerivedValue:     ${meter.applyCount} calls, ${(meter.applyMs / Math.max(1, meter.applyCount)).toFixed(3)} ms/call`
		);
		console.log(
			`  flushDerived:          ${meter.flushCount} calls, ${(meter.flushMs / Math.max(1, meter.flushCount)).toFixed(3)} ms/call`
		);
		console.log(
			`  flush share:           ${((meter.flushMs / Math.max(1, meter.applyMs + meter.flushMs)) * 100).toFixed(1)} %`
		);
		console.log(`  flushes per record:    ${(meter.flushCount / TRICKLE).toFixed(2)}`);
	});

	it('repeated keys: upper bound on what per-key coalescing could remove', async () => {
		resetMeter();
		const first = SEED + BURST + TRICKLE + 10;
		for (let round = 0; round < HOT_ROUNDS; round++) {
			for (let k = 0; k < HOT_KEYS; k++) await Bench.put(first + k, { vector: makeVector() });
		}
		await drained();
		const writes = HOT_KEYS * HOT_ROUNDS;
		console.log(`\n== ${HOT_KEYS} keys × ${HOT_ROUNDS} rounds = ${writes} commits ==`);
		console.log(`  applyDerivedValue:   ${meter.applyCount} calls (${HOT_KEYS} distinct keys)`);
		console.log(`  time in apply:       ${meter.applyMs.toFixed(0)} ms`);
		console.log(
			`  repeated keys:       ${(((meter.applyCount - HOT_KEYS) / Math.max(1, meter.applyCount)) * 100).toFixed(1)} % of apply calls`
		);
		console.log(`  flushDerived:        ${meter.flushCount} calls, ${meter.flushMs.toFixed(0)} ms total`);
	});
});
