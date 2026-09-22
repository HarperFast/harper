// QA-822 fixture resources. Everything else this suite needs (insert, read_audit_log,
// delete_transaction_logs_before, get_job) is a standard Harper surface the test hits directly.
//
// Both routes resolve a fixture table out of the global `tables` alias, so a 200 from
// `/LogStats/` is also the suite's readiness signal: an HTTP server answering before the
// databases are open cannot produce one.

const ALL_TABLES = ['PurgeVictim', 'Healer', 'QuietTarget'];

function tableFor(name) {
	const table = tables[name];
	if (!table) throw new Error(`QA-822: table ${name} not found`);
	return table;
}

// The storage engine in effect, derived rather than trusted: an LMDB primary store is a `.mdb`
// file and only the RocksDB root store exposes `purgeLogs`. Every assertion in this suite is
// about the RocksDB native transaction log, so the suite hard-asserts this rather than letting
// an LMDB run pass vacuously.
function engineOf(table) {
	const primaryPath = table.primaryStore?.path || table.primaryStore?.rootStore?.path || null;
	if (typeof primaryPath === 'string' && primaryPath.endsWith('.mdb')) return 'lmdb';
	if (typeof table.primaryStore?.rootStore?.purgeLogs === 'function') return 'rocksdb';
	return 'unknown';
}

// POST /Flush/ — flush every fixture table's primary store. `delete_transaction_logs_before` only
// deletes log files entirely before the last-flushed-to-RocksDB position, so without this the
// purge has nothing eligible to delete and the whole suite arms vacuously.
export class Flush extends Resource {
	static loadAsInstance = false;
	async post() {
		const flushed = {};
		for (const name of ALL_TABLES) {
			const store = tableFor(name).primaryStore;
			flushed[name] = typeof store?.flush === 'function';
			if (flushed[name]) await store.flush();
		}
		return { ok: true, flushed };
	}
}

// GET /LogStats/?table=<name> — the native transaction-log snapshot for the table's shared log.
// `lastFlushedPosition` is invariant 1's oracle; `nextLogPosition` is the log's write cursor, which
// is what makes commit grouping's effect on the log's byte layout directly measurable.
export class LogStats extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const name = String(query?.get?.('table') ?? 'QuietTarget');
		const table = tableFor(name);
		const engine = engineOf(table);
		const log = table.auditStore?.log;
		if (!log || typeof log.getStats !== 'function') return { available: false, engine };
		const stats = log.getStats();
		return {
			available: true,
			engine,
			name: stats.name,
			fileCount: stats.fileCount,
			currentSequenceNumber: stats.currentSequenceNumber,
			oldestSequenceNumber: stats.oldestSequenceNumber,
			nextLogPosition: stats.nextLogPosition,
			lastFlushedPosition: stats.lastFlushedPosition,
			rotations: stats.totals?.rotations,
			entriesWritten: stats.totals?.entriesWritten,
			filesPurged: stats.totals?.filesPurged,
			maxFileSize: stats.config?.maxFileSize,
		};
	}
}
