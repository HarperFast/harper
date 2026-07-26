// QA-779 fixture resources. Reused from QA-777's shape (same Ledger table / purge mechanics).
//
// Probe: readiness poll target (component pre-installed; caller polls this route until it
// stops 404ing instead of restarting HTTP workers, per the harness's known race).
//
// StorageEngineInfo: code-derived signal for which storage engine is actually backing the
// Ledger table, so the test HARD-ASSERTS the engine in effect rather than trusting that config
// was honored.
//
// Flush: forces the Ledger table's RocksDB column family to flush its memtable to SST. QA-732/
// QA-746 found flush is a separate gate on top of delete_audit_logs_before/purgeLogs — without
// it, unflushed memtable writes don't get reflected in what purgeLogs can reclaim on disk.

export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}

export class StorageEngineInfo extends Resource {
	static loadAsInstance = false;
	async get() {
		const t = tables['Ledger'];
		if (!t) throw new Error('QA-779: table Ledger not found');
		const primaryPath = t.primaryStore?.path || t.primaryStore?.rootStore?.path || null;
		const looksLikeLmdbPath = typeof primaryPath === 'string' && primaryPath.endsWith('.mdb');
		const hasPurgeLogs = typeof t.primaryStore?.rootStore?.purgeLogs === 'function';
		return {
			primaryPath,
			looksLikeLmdbPath,
			hasPurgeLogs,
			engineGuess: looksLikeLmdbPath ? 'lmdb' : hasPurgeLogs ? 'rocksdb' : 'unknown',
		};
	}
}

export class Flush extends Resource {
	static loadAsInstance = false;
	async post() {
		const t = tables['Ledger'];
		if (!t || typeof t.primaryStore.flush !== 'function') {
			return { ok: true, flushed: false };
		}
		await t.primaryStore.flush();
		return { ok: true, flushed: true };
	}
}
