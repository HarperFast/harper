// QA-816 fixture resources. Everything else this suite needs (insert, REST reads,
// search_by_value, read_audit_log, delete_transaction_logs_before) is a standard Harper surface
// the test hits directly.
//
// The global `tables` object aliases only the `data` database, so every lookup here goes through
// `databases[<database>][<table>]`.

const DATABASES = {
	qa816a: ['Ledger', 'QuietLedger', 'Churn'],
	qa816b: ['RemoteLedger', 'RemoteChurn'],
};

function tableFor(databaseName, tableName) {
	const table = databases[databaseName] && databases[databaseName][tableName];
	if (!table) throw new Error(`QA-816: table ${databaseName}.${tableName} not found`);
	return table;
}

function queryValue(query, name) {
	if (!query) return undefined;
	return typeof query.get === 'function' ? query.get(name) : query[name];
}

function logStats(auditStore) {
	const log = auditStore && auditStore.log;
	if (!log || typeof log.getStats !== 'function') return null;
	const stats = log.getStats();
	return {
		path: stats.path,
		fileCount: stats.fileCount,
		oldestSequenceNumber: stats.oldestSequenceNumber,
		currentSequenceNumber: stats.currentSequenceNumber,
		lastFlushedSequence: stats.lastFlushedPosition && stats.lastFlushedPosition.sequence,
		rotations: stats.totals && stats.totals.rotations,
		filesPurged: stats.totals && stats.totals.filesPurged,
		entriesWritten: stats.totals && stats.totals.entriesWritten,
		maxFileSize: stats.config && stats.config.maxFileSize,
	};
}

export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}

// GET /LogTopology/ -> per-table engine guess plus the identity of the native transaction log
// each table writes its audit entries to. Identity is reported as an index into a list of
// distinct objects seen, so the test can assert "these two tables share one log" and "these two
// do not" directly rather than inferring it from paths.
export class LogTopology extends Resource {
	static loadAsInstance = false;
	async get() {
		const auditStores = [];
		const logs = [];
		const identify = (list, value) => {
			if (value == null) return -1;
			let index = list.indexOf(value);
			if (index === -1) index = list.push(value) - 1;
			return index;
		};
		const result = {};
		for (const [databaseName, tableNames] of Object.entries(DATABASES)) {
			for (const tableName of tableNames) {
				const table = tableFor(databaseName, tableName);
				const primaryPath = table.primaryStore?.path || table.primaryStore?.rootStore?.path || null;
				const looksLikeLmdbPath = typeof primaryPath === 'string' && primaryPath.endsWith('.mdb');
				const hasPurgeLogs = typeof table.primaryStore?.rootStore?.purgeLogs === 'function';
				result[`${databaseName}.${tableName}`] = {
					database: databaseName,
					table: tableName,
					engineGuess: looksLikeLmdbPath ? 'lmdb' : hasPurgeLogs ? 'rocksdb' : 'unknown',
					auditStoreId: identify(auditStores, table.auditStore),
					logId: identify(logs, table.auditStore && table.auditStore.log),
					log: logStats(table.auditStore),
				};
			}
		}
		return result;
	}
}

// POST /Flush/?database=qa816a -> force that database's memtables to disk. Every table in the
// database is flushed, not just one: the transaction log's last-flushed position cannot pass an
// unflushed column family, and the native purge only deletes log files entirely before that
// position, so a single-table flush leaves the log un-purgeable whenever another table in the
// database still holds a memtable.
export class Flush extends Resource {
	static loadAsInstance = false;
	async post(query) {
		const databaseName = String(queryValue(query, 'database') || '');
		const tableNames = DATABASES[databaseName];
		if (!tableNames) throw new Error(`QA-816: unknown database ${databaseName}`);
		for (const tableName of tableNames) {
			const table = tableFor(databaseName, tableName);
			if (typeof table.primaryStore.flush !== 'function')
				throw new Error(`QA-816: ${databaseName}.${tableName} primaryStore.flush() unavailable (not RocksDB?)`);
			await table.primaryStore.flush();
		}
		return { ok: true, flushed: true, database: databaseName, tables: tableNames };
	}
}

// GET /FullScan/?database=&table=&mode=count|records -> index-independent primary-store scan.
// `records` returns every row; `count` returns only the total, for the churn tables whose rows are
// large and whose survival is asserted by count.
export class FullScan extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const databaseName = String(queryValue(query, 'database') || '');
		const tableName = String(queryValue(query, 'table') || '');
		const mode = String(queryValue(query, 'mode') || 'records');
		const table = tableFor(databaseName, tableName);
		let totalCount = 0;
		const records = [];
		for await (const record of table.search({})) {
			totalCount++;
			if (mode === 'records')
				records.push({ id: record.id, seq: record.seq, bucket: record.bucket, payload: record.payload });
		}
		return { database: databaseName, table: tableName, totalCount, records };
	}
}
