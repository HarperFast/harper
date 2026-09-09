/**
 * Benchmark: the shared derived-index runtime feeding a backend with a synthetic per-mutation cost
 * and a fixed-cost durability barrier. Run via: npx mocha unitTests/resources/derivedIndexRuntime.bench.js
 */
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const {
	DERIVED_INDEX_ACCEPTED,
	DERIVED_INDEX_DEFERRED,
	DerivedIndexRuntime,
} = require('#src/resources/derivedIndexRuntime');

const APPLY_MICROS = Number(process.env.DERIVED_BENCH_APPLY_MICROS ?? 350);
const BARRIER_MILLIS = Number(process.env.DERIVED_BENCH_BARRIER_MILLIS ?? 5);
const DIMENSIONS = 384;
const RECORD_BYTES = DIMENSIONS * 4;

function busyWait(micros) {
	const until = performance.now() + micros / 1000;
	while (performance.now() < until);
}

class LiveLogStore {
	constructor() {
		this.log = [];
		this.locks = new Set();
		this.sharedBuffers = new Map();
		this.rootStore = new EventEmitter();
		this.rootStore.listLogs = () => ['local'];
		this.rootStore.useLog = (name) => ({ name, getStats: () => ({ oldestSequenceNumber: 1 }) });
		this.nextTimestamp = 1;
	}

	commit(recordId, size = RECORD_BYTES) {
		const timestamp = this.nextTimestamp++;
		this.log.push({
			logName: 'local',
			txnLogKey: timestamp,
			version: timestamp,
			recordId,
			tableId: 1,
			type: 'put',
			endTxn: true,
			size,
			committedAt: performance.now(),
		});
		this.rootStore.emit('committed');
		return timestamp;
	}

	getRange(options) {
		const start = options.startByLog?.get('local') ?? 0;
		const log = this.log;
		let index = log.findIndex((entry) => entry.txnLogKey > start);
		if (index < 0) index = log.length;
		return {
			corruptFrameStop: { breaks: 0, truncatedVersions: new Set(), midLogBreak: false },
			failedLogs: new Set(),
			exactStartFailures: new Map(),
			[Symbol.iterator]() {
				return {
					next: () => (index < log.length ? { value: log[index++], done: false } : { value: undefined, done: true }),
					return: () => ({ value: undefined, done: true }),
				};
			},
		};
	}

	tryLock(key) {
		if (this.locks.has(key)) return false;
		this.locks.add(key);
		return true;
	}

	unlock(key) {
		this.locks.delete(key);
	}

	getUserSharedBuffer(key, defaultBuffer) {
		let buffer = this.sharedBuffers.get(key);
		if (!buffer) this.sharedBuffers.set(key, (buffer = new SharedArrayBuffer(defaultBuffer.byteLength)));
		return buffer;
	}
}

class InlineBackend {
	constructor(id, { useRecords = true } = {}) {
		this.id = id;
		this.cursor = { format: 1, logs: {} };
		this.applies = 0;
		this.useRecords = useRecords;
	}
	getDurableCursor() {
		return this.cursor;
	}
	deliver(batch) {
		const mutations = this.useRecords
			? batch.records
			: batch.transactions.flatMap((transaction) => transaction.mutations);
		for (let i = 0; i < mutations.length; i++) {
			busyWait(APPLY_MICROS);
			this.applies++;
		}
		busyWait(BARRIER_MILLIS * 1000);
		this.barriers = (this.barriers ?? 0) + 1;
		this.cursor = batch.through;
		return DERIVED_INDEX_ACCEPTED;
	}
	onStateChange(wake) {
		this.wake = wake;
		return () => {};
	}
}

class QueueBackend {
	constructor(id, { sliceMillis = 4, capacityBytes = 64 * 1024 * 1024 } = {}) {
		this.id = id;
		this.queued = true;
		this.cursor = { format: 1, logs: {} };
		this.queue = [];
		this.queuedBytes = 0;
		this.peakQueuedBytes = 0;
		this.applies = 0;
		this.barriers = 0;
		this.appliedCursor = this.cursor;
		this.appliedAt = new Map();
		this.durableAt = new Map();
		this.sliceMillis = sliceMillis;
		this.capacityBytes = capacityBytes;
		this.scheduled = false;
		this.flushRequested = false;
		this.flushing = false;
		this.position = 0;
	}
	attach(host) {
		this.host = host;
	}
	getDurableCursor() {
		return this.cursor;
	}
	deliver(batch) {
		if (this.queuedBytes >= this.capacityBytes) return DERIVED_INDEX_DEFERRED;
		this.queue.push(batch);
		this.queuedBytes += batch.bytes;
		this.peakQueuedBytes = Math.max(this.peakQueuedBytes, this.queuedBytes);
		this.schedule();
		return DERIVED_INDEX_ACCEPTED;
	}
	schedule() {
		if (this.scheduled) return;
		this.scheduled = true;
		setImmediate(() => {
			this.scheduled = false;
			const until = performance.now() + this.sliceMillis;
			while (this.queue.length && performance.now() < until) {
				const batch = this.queue[0];
				if (!this.host.isOwnerEpoch(batch.ownerEpoch)) {
					this.queue.shift();
					continue;
				}
				while (this.position < batch.records.length && performance.now() < until) {
					busyWait(APPLY_MICROS);
					this.applies++;
					this.appliedAt.set(batch.records[this.position].logVersion, performance.now());
					this.position++;
				}
				if (this.position < batch.records.length) break;
				this.queue.shift();
				this.queuedBytes -= batch.bytes;
				this.position = 0;
				if (batch.through) this.appliedCursor = batch.through;
			}
			if (this.queue.length) this.schedule();
			else if (this.flushRequested) this.runFlush();
			if (this.queuedBytes < this.capacityBytes) this.wake?.('changed');
		});
	}
	flush() {
		this.flushRequested = true;
		if (!this.queue.length) this.runFlush();
	}
	runFlush() {
		if (this.flushing) return;
		this.flushRequested = false;
		this.flushing = true;
		const through = this.appliedCursor;
		setImmediate(() => {
			busyWait(BARRIER_MILLIS * 1000);
			this.barriers++;
			this.flushing = false;
			this.cursor = through;
			const now = performance.now();
			for (const version of this.appliedAt.keys()) {
				if (version <= (through.logs.local ?? 0) && !this.durableAt.has(version)) this.durableAt.set(version, now);
			}
			this.wake?.('changed');
		});
	}
	shutdown() {
		this.queue.length = 0;
		this.queuedBytes = 0;
	}
	onStateChange(wake) {
		this.wake = wake;
		return () => {};
	}
}

function makeRuntime(store, options) {
	const vector = new Float32Array(DIMENSIONS);
	return new DerivedIndexRuntime(
		store,
		(tableId, recordId) => ({ version: 1, value: { id: recordId, vector }, size: RECORD_BYTES }),
		{ idleGraceMilliseconds: 60_000, ...options }
	);
}

const registration = (backend, options) => ({
	backend,
	projections: new Map([[1, (record) => record.vector]]),
	options,
});

const until = (condition, timeout = 120_000) =>
	new Promise((resolve, reject) => {
		const deadline = Date.now() + timeout;
		const poll = () => {
			if (condition()) return resolve();
			if (Date.now() > deadline) return reject(new Error('bench condition timed out'));
			setTimeout(poll, 5);
		};
		poll();
	});

function eventLoopProbe() {
	const probe = { max: 0, samples: [] };
	let last = performance.now();
	const interval = setInterval(() => {
		const now = performance.now();
		const delay = now - last - 1;
		probe.samples.push(delay);
		probe.max = Math.max(probe.max, delay);
		last = now;
	}, 1);
	probe.stop = () => {
		clearInterval(interval);
		probe.samples.sort((a, b) => a - b);
		probe.p99 = probe.samples[Math.floor(probe.samples.length * 0.99)] ?? 0;
		return probe;
	};
	return probe;
}

const fmt = (n, digits = 1) => Number(n).toFixed(digits);

describe('Benchmark: derived-index runtime with a costly native-shaped backend', function () {
	this.timeout(0);

	before(() => {
		console.log(`\n  apply cost ${APPLY_MICROS} µs/mutation, barrier ${BARRIER_MILLIS} ms, ${DIMENSIONS}-d records`);
	});

	it('coalescing: repeated keys within one delivery window', async () => {
		for (const useRecords of [false, true]) {
			const store = new LiveLogStore();
			for (let round = 0; round < 20; round++) for (let key = 0; key < 50; key++) store.commit(`k${key}`);
			const backend = new InlineBackend(`coalesce-${useRecords}`, { useRecords });
			const runtime = makeRuntime(store, { maxTransactionsPerTurn: 1000, maxMillisecondsPerTurn: 1000 });
			const started = performance.now();
			runtime.register(registration(backend));
			await until(() => backend.cursor.logs.local === store.nextTimestamp - 1);
			const elapsed = performance.now() - started;
			console.log(
				`  ${useRecords ? 'records (coalesced)' : 'transactions (per occurrence)'}`.padEnd(38) +
					`| applies ${String(backend.applies).padStart(5)} | ${fmt(elapsed)} ms for 1000 transactions over 50 keys`
			);
			await runtime.stop();
		}
	});

	it('queue-and-accept: event-loop delay while a 5,000-mutation window is applied', async () => {
		for (const shape of ['inline', 'queued']) {
			const store = new LiveLogStore();
			for (let i = 0; i < 5000; i++) store.commit(`r${i}`);
			const backend = shape === 'inline' ? new InlineBackend(shape) : new QueueBackend(shape, { sliceMillis: 4 });
			const runtime = makeRuntime(store, { maxTransactionsPerTurn: 5000, maxMillisecondsPerTurn: 50 });
			const probe = eventLoopProbe();
			const started = performance.now();
			runtime.register(registration(backend, { flushAfterMutations: 5000, maxFlushAgeMilliseconds: 50 }));
			await until(() => backend.cursor.logs.local === store.nextTimestamp - 1);
			const elapsed = performance.now() - started;
			const { max, p99 } = probe.stop();
			console.log(
				`  ${shape}`.padEnd(38) +
					`| loop delay max ${fmt(max).padStart(7)} ms, p99 ${fmt(p99).padStart(6)} ms | ${fmt(elapsed)} ms total, ${fmt((5000 / elapsed) * 1000, 0)} mutations/s`
			);
			await runtime.stop();
		}
	});

	it('independently paced arrivals: latency, throughput, queue bytes, durability age per cadence', async () => {
		const RATE = Number(process.env.DERIVED_BENCH_RATE ?? 1500);
		const SECONDS = Number(process.env.DERIVED_BENCH_SECONDS ?? 3);
		const cadences = [
			['flush every batch', { flushAfterMutations: 1, maxFlushAgeMilliseconds: 1 }],
			['age 100 ms / 512 mutations', { flushAfterMutations: 512, maxFlushAgeMilliseconds: 100 }],
			['default (age 1 s / 4096)', {}],
		];
		console.log(`  arrivals at ${RATE}/s for ${SECONDS} s, 200 distinct keys`);
		for (const [name, options] of cadences) {
			const store = new LiveLogStore();
			const backend = new QueueBackend(`paced-${name}`, { sliceMillis: 4 });
			const runtime = makeRuntime(store, { maxMillisecondsPerTurn: 5 });
			let peakAccepted = 0;
			runtime.register(registration(backend, options));
			const total = RATE * SECONDS;
			let committed = 0;
			const startedAt = performance.now();
			await new Promise((resolve) => {
				const tick = () => {
					const due = Math.min(total, Math.floor(((performance.now() - startedAt) / 1000) * RATE));
					while (committed < due) store.commit(`k${committed++ % 200}`);
					peakAccepted = Math.max(peakAccepted, runtime.getMetrics(backend.id).acceptedBytes);
					if (committed >= total) resolve();
					else setTimeout(tick, 1);
				};
				tick();
			});
			await until(() => backend.cursor.logs.local === store.nextTimestamp - 1);
			const finishedAt = performance.now();
			const latencies = [];
			let maxAge = 0;
			for (const entry of store.log) {
				const durableAt = backend.durableAt.get(entry.txnLogKey);
				if (durableAt === undefined) continue;
				latencies.push(durableAt - entry.committedAt);
				maxAge = Math.max(maxAge, durableAt - entry.committedAt);
			}
			latencies.sort((a, b) => a - b);
			const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
			const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
			console.log(
				`  ${name}`.padEnd(30) +
					`| write→durable p50 ${fmt(p50).padStart(7)} ms p99 ${fmt(p99).padStart(7)} ms max ${fmt(maxAge).padStart(7)} ms` +
					` | indexed ${fmt((total / (finishedAt - startedAt)) * 1000, 0).padStart(5)}/s, applies ${backend.applies}` +
					` | peak queue ${fmt(Math.max(peakAccepted, backend.peakQueuedBytes) / 1024, 0)} KiB | barriers ${backend.barriers}`
			);
			await runtime.stop();
		}
	});
});
