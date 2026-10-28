import { threadId } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

const { Counter } = tables;

// Benchmark diagnostics in a process-wide shared buffer (BigInt64 words):
// [0] successful Increment commits; per thread slot (BASE + slot*4): ELU active µs, ELU idle µs, thread CPU µs,
// present flag; per retry kind (KINDS + kind*2): retries, JS CPU µs of their synchronous replay.
const SLOTS = 64;
const BASE = 16;
const KINDS = BASE + SLOTS * 4;
let diag;
function getDiag() {
	diag ??= new BigInt64Array(Counter.primaryStore.getUserSharedBuffer('hkc-diag', new ArrayBuffer(8 * (KINDS + 16))));
	return diag;
}
if (threadId > 0) {
	setInterval(() => {
		const d = getDiag();
		const elu = performance.eventLoopUtilization();
		const cpu = process.threadCpuUsage();
		const at = BASE + (threadId % SLOTS) * 4;
		Atomics.store(d, at, BigInt(Math.round(elu.active * 1000)));
		Atomics.store(d, at + 1, BigInt(Math.round(elu.idle * 1000)));
		Atomics.store(d, at + 2, BigInt(cpu.user + cpu.system));
		Atomics.store(d, at + 3, 1n);
	}, 100).unref();
	globalThis.__hkcRetryDiag = (kind, us) => {
		const d = getDiag();
		Atomics.add(d, KINDS + kind * 2, 1n);
		Atomics.add(d, KINDS + kind * 2 + 1, BigInt(Math.round(us)));
	};
}

export class Increment extends Resource {
	static loadAsInstance = false;

	async post(_target, { ids, mode }) {
		for (const id of ids) {
			const record = await Counter.update(id);
			if (mode === 'set') record.set('count', record.count + 1);
			else record.addTo('count', 1);
		}
		// Commit here rather than after return so the native handle's retry count is final; both
		// conflict-retry paths in DatabaseTransaction.commit() bump it and keep the same handle. LMDB has no
		// such handle, so it reports null rather than a misleading 0.
		const transaction = this.getContext().transaction;
		const handle = transaction.transaction;
		await transaction.commit();
		Atomics.add(getDiag(), 0, 1n);
		return { thread: threadId, retries: handle ? (handle.retries ?? 0) : null };
	}
}

export class Seed extends Resource {
	static loadAsInstance = false;

	async post(_target, { start, count }) {
		for (let id = start; id < start + count; id++) await Counter.put({ id, count: 0 });
		return { ok: true };
	}
}

export class Counts extends Resource {
	static loadAsInstance = false;

	async post(_target, { ids }) {
		const counts = [];
		for (const id of ids) counts.push((await Counter.get(id))?.count ?? null);
		return counts;
	}
}

// Native commit counters from the rocksdb-js build under test (abort-marker prototype only).
export class CommitStats extends Resource {
	static loadAsInstance = false;

	get() {
		return {
			native: Counter.primaryStore?.useLog?.('local')?.getStats?.()?.totals ?? null,
			pid: process.pid,
			diag: Array.from(getDiag(), Number),
		};
	}
}
