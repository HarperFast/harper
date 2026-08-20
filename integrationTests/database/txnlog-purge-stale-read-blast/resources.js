// QA-782 fixture resources — bound the blast radius of F-225 (in-process stale-read cache
// after a RocksDB audit-purge, root-caused in QA-781 to rocksdb-js's TransactionLog
// `_logBuffers` mmap cache) beyond the audit/txnlog path. Only two custom endpoints are
// needed: everything else (REST record GET, REST collection query, search_by_value, SQL,
// read_audit_log, delete_transaction_logs_before) is a standard Harper surface hit directly
// from the test.
//
// StorageEngineInfo: same engine-detection shape as QA-779/QA-787 (looksLikeLmdbPath vs
// hasPurgeLogs), reused verbatim so the precondition check is proven, not assumed.
//
// FullScan: the index-independent oracle. Walks tables.Widget.search({}) with NO
// conditions (a genuine primary-store scan, bypassing the @indexed `bucket` path entirely)
// and reports total row count plus presence/value for a requested id list, so a stale
// cache that only affects the index (or only affects point lookups) can't hide from it.

export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}

export class StorageEngineInfo extends Resource {
	static loadAsInstance = false;
	async get() {
		const t = tables['Widget'];
		if (!t) throw new Error('QA-782: table Widget not found');
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
		const t = tables['Widget'];
		if (!t || typeof t.primaryStore.flush !== 'function') {
			return { ok: true, flushed: false };
		}
		await t.primaryStore.flush();
		return { ok: true, flushed: true };
	}
}

// GET /FullScan/?ids=k1,k2,... -> { totalCount, records: { id: {seq,bucket,payload} | null } }
// Index-independent full primary-store scan (the ground-truth oracle).
export class FullScan extends Resource {
	static loadAsInstance = false;
	async get(query) {
		// `query` extends URLSearchParams -- must use .get(), plain property access is always
		// undefined (same trap documented in QA-787/QA-781 fixtures).
		const ids = String(query?.get?.('ids') ?? '')
			.split(',')
			.filter(Boolean);
		const idSet = new Set(ids);
		let totalCount = 0;
		const records = {};
		for await (const r of tables.Widget.search({})) {
			totalCount++;
			if (idSet.has(r.id)) records[r.id] = { seq: r.seq, bucket: r.bucket, payload: r.payload };
		}
		for (const id of ids) if (!(id in records)) records[id] = null;
		return { totalCount, records };
	}
}

// DIAGNOSTIC ONLY (harper#2243) — not for merge. Exposes the RocksDB stat counters that
// discriminate a write stall from slow flush/fsync on Windows. `enableStats: true` is already
// set for every RocksDB database (resources/databases.ts), so the curated keys are populated.
export class RocksStats extends Resource {
	static loadAsInstance = false;
	async get() {
		const t = tables['Widget'];
		const root = t?.primaryStore?.rootStore;
		if (!root || typeof root.getStats !== 'function') return { available: false };
		let stats;
		try {
			stats = root.getStats();
		} catch (error) {
			return { available: false, error: String(error) };
		}
		const pick = (k) => stats?.[k];
		return {
			available: true,
			stallMicros: pick('rocksdb.stall.micros'),
			writeStall: pick('rocksdb.db.write.stall'),
			flushMicros: pick('rocksdb.db.flush.micros'),
			writeMicros: pick('rocksdb.db.write.micros'),
			compactionTimesMicros: pick('rocksdb.compaction.times.micros'),
			numImmutableMemTable: pick('rocksdb.num-immutable-mem-table'),
			memTableFlushPending: pick('rocksdb.mem-table-flush-pending'),
			numRunningFlushes: pick('rocksdb.num-running-flushes'),
			numRunningCompactions: pick('rocksdb.num-running-compactions'),
			compactionPending: pick('rocksdb.compaction-pending'),
			estimatePendingCompactionBytes: pick('rocksdb.estimate-pending-compaction-bytes'),
			bytesWritten: pick('rocksdb.bytes.written'),
			keysWritten: pick('rocksdb.number.keys.written'),
			txnlogBytesWritten: pick('txnlog.bytesWritten'),
			commitPipelineLogQueueDepth: pick('commitPipeline.logQueueDepth'),
			commitPipelineCommitQueueDepth: pick('commitPipeline.commitQueueDepth'),
		};
	}
}
