import { setTimeout as delay } from 'node:timers/promises';

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
//
// Direct-store oracle: search_by_value joins every hit back through the primary record and
// silently drops any hit whose record is gone, so it cannot see a dangling/phantom secondary-
// index entry. The routes below read the raw secondary-index dbi directly instead, and bind the
// raw primary scan + raw index scan to ONE shared read transaction (Table._readTxnForContext)
// so a concurrent eviction commit cannot land between the two reads.
//
//   GET  /RawSnapshot/?table=X&attr=bucket — { rows, indexEntries }, both read under one
//                        transaction: rows is a raw primaryStore scan (physical presence, not
//                        Table.search()'s logical/expiration-filtered view); indexEntries is a
//                        raw index.getRange({start:null}) scan (includes null-keyed entries).
//   POST /PlantDangling/   { table, attr, value, key } — writes DIRECTLY into the raw index dbi
//                        with no corresponding primary row, to prove RawSnapshot can see one.
//   POST /RemoveIndexEntry/ { table, attr, value, key } — cleans up a planted entry.

function pad(n) {
	return String(n).padStart(6, '0');
}

function getTable(name) {
	const t = tables[name];
	if (!t) throw new Error(`unknown table "${name}"`);
	return t;
}
function qget(query, key) {
	if (!query) return undefined;
	return query.get ? query.get(key) : query[key];
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

export class PacedDumpP extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const row of tables.Permanent.search({})) {
			out.push(row.id);
			// Model a streaming consumer spanning several 5ms idle-monitor ticks.
			await delay(2);
		}
		return out;
	}
}

// GET /RawSnapshot/?table=X&attr=bucket -> { rows, indexEntries }, both read under one shared
// transaction -- see file header. rows is physical-presence truth (unlike DumpE/DumpP's
// Table.search(), which applies expiration semantics); indexEntries is the raw secondary index,
// including null-keyed entries.
export class RawSnapshot extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const t = getTable(qget(query, 'table'));
		const attr = qget(query, 'attr') || 'bucket';
		const index = t.indices[attr];
		if (!index) throw new Error(`No index ${attr} on ${t.tableName}`);
		const transaction = t._readTxnForContext(this.getContext());

		const rows = [];
		for (const entry of t.primaryStore.getRange({ start: false, versions: true, transaction })) {
			if (entry.value == null) continue; // tombstone
			if (typeof entry.key === 'symbol') continue; // internal metadata entry, not a row
			rows.push({ id: entry.key, bucket: entry.value.bucket, seq: entry.value.seq });
		}

		const indexEntries = [];
		// start: null is required or an unqualified getRange() silently skips null-keyed entries.
		for (const entry of index.getRange({ start: null, transaction })) {
			indexEntries.push({ indexedValue: entry.key, primaryKey: entry.value });
		}

		return { rows, indexEntries };
	}
}

// Writes straight into the raw index dbi, bypassing put()/the record layer entirely, so there
// is deliberately NO primary row behind this entry. Proves the RawSnapshot oracle isn't blind.
export class PlantDangling extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const index = t.indices[b.attr || 'bucket'];
		if (!index) throw new Error(`No index ${b.attr || 'bucket'} on ${t.tableName}`);
		await index.put(b.value, b.key);
		return { ok: true, table: b.table, attr: b.attr || 'bucket', value: b.value, key: b.key };
	}
}

export class RemoveIndexEntry extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const index = t.indices[b.attr || 'bucket'];
		if (!index) throw new Error(`No index ${b.attr || 'bucket'} on ${t.tableName}`);
		await index.remove(b.value, b.key);
		return { ok: true, table: b.table, attr: b.attr || 'bucket', value: b.value, key: b.key };
	}
}
