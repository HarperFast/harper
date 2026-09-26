// QA-822 fixture resources: the two things the suite needs that no operations-API surface exposes.
// Everything else it does goes through the standard API.

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

// `delete_transaction_logs_before` only deletes log files entirely before the last-flushed-to-
// RocksDB position, so without this the purge has nothing eligible to delete and the suite arms
// vacuously.
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

// `nextLogPosition` is the log's write cursor, which is what makes commit grouping's effect on the
// byte layout measurable at all; the operations API exposes neither position.
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
