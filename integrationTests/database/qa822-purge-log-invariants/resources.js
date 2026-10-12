// QA-822 fixture resources: the two things the suite needs that no operations-API surface exposes.
// Everything else it does goes through the standard API.

const ALL_TABLES = [
	['data', 'PurgeVictim'],
	['data', 'Healer'],
	['data', 'QuietTarget'],
	['qa1730', 'ReopenTarget'],
];

// The global `tables` only aliases the default `data` database; `qa1730`'s table is reached
// through `databases`, same as `data`'s own tables would be if addressed that way.
function tableFor(databaseName, name) {
	const table = databaseName === 'data' ? tables[name] : databases[databaseName]?.[name];
	if (!table) throw new Error(`QA-822: table ${databaseName}.${name} not found`);
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
		for (const [database, name] of ALL_TABLES) {
			const store = tableFor(database, name).primaryStore;
			const key = `${database}.${name}`;
			flushed[key] = typeof store?.flush === 'function';
			if (flushed[key]) await store.flush();
		}
		return { ok: true, flushed };
	}
}

// `nextLogPosition` is the log's write cursor, which is what makes commit grouping's effect on the
// byte layout measurable at all; the operations API exposes neither position. `path` lets the
// caller inspect the log directory directly while the process is down (between a kill and the
// next start), which no running-server endpoint can answer.
export class LogStats extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const name = String(query?.get?.('table') ?? 'QuietTarget');
		const database = String(query?.get?.('database') ?? 'data');
		const table = tableFor(database, name);
		const engine = engineOf(table);
		const log = table.auditStore?.log;
		if (!log || typeof log.getStats !== 'function') return { available: false, engine };
		const stats = log.getStats();
		return {
			available: true,
			engine,
			name: stats.name,
			path: stats.path,
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
