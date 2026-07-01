// QA-179 — TTL background expiration/eviction sweep vs secondary-index consistency under
// long-transaction force-commit.
//
// The eviction path under test (resources/Table.ts on dist 7aaa5a152):
//   scheduleCleanup() (runs on the LAST worker = threads.count-1) scans the primary store,
//   and for every expired row calls TableResource.evict(key, record, version). evict()
//   opens its OWN DatabaseTransaction, getReadTxn() (registering it with the long-transaction
//   monitor), then updateIndices(id, record, null) (remove the @indexed entry) AND
//   removeEntry() (remove the base row), then commit()s. Up to MAX_CLEANUP_CONCURRENCY=50
//   evict() txns are in-flight concurrently, with `await rest()` between scanned records.
//   With storage.maxTransactionOpenTime:1 + debugLongTransactions:true the over-time monitor
//   force-commits/aborts a tracked eviction txn that crosses the threshold mid-flight.
//
// We just need to load rows and read them back; the eviction sweep fires on its own schedule
// (scanInterval:2s). All custom endpoints below are thin loaders / index-independent oracles
// driven from the test.
//
// Endpoints (POST body { count, bucket }):
//   POST /Load/      { table, count, bucket, ttlOffset } — insert `count` rows into the named
//                    table ('Expiring' | 'Permanent') with the given bucket. Returns { ok, count }.
//   GET  /CountE/    — { count } exact Expiring base-row count (full scan, index-independent).
//   GET  /DumpE/     — [{ id, bucket, seq }] every Expiring base row (base oracle).
//   GET  /DumpP/     — [{ id, bucket, seq }] every Permanent base row (base oracle).

function pad(n) {
	return String(n).padStart(6, '0');
}

// POST /Load/ { table, count, bucket } — bulk insert rows into Expiring or Permanent.
export class Load extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const tableName = b.table === 'Permanent' ? 'Permanent' : 'Expiring';
		const table = tables[tableName];
		const n = Number(b.count) || 0;
		const bucket = b.bucket || 'B';
		for (let i = 0; i < n; i++) {
			await table.put({ id: `${bucket}-${pad(i)}`, bucket, seq: i, payload: 'x'.repeat(64) });
		}
		return { ok: true, table: tableName, count: n, bucket };
	}
}

// GET /CountE/ -> { count } exact Expiring base row count (index-independent full scan).
export class CountE extends Resource {
	static loadAsInstance = false;
	async get() {
		let count = 0;
		for await (const _r of tables.Expiring.search({})) count++;
		return { count };
	}
}

// GET /DumpE/ -> [{ id, bucket, seq }] every Expiring base row (the base-table oracle).
export class DumpE extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const r of tables.Expiring.search({})) out.push({ id: r.id, bucket: r.bucket, seq: r.seq });
		return out;
	}
}

// GET /DumpP/ -> [{ id, bucket, seq }] every Permanent base row (control-table oracle).
export class DumpP extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const r of tables.Permanent.search({})) out.push({ id: r.id, bucket: r.bucket, seq: r.seq });
		return out;
	}
}
