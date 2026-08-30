// Workload drivers for delete-index-atomicity-rocksdb.test.ts (regression anchor for #1854).
// The oracle itself lives outside this process — the test opens the raw RocksDB directory with
// its own read-only handles. These resources only drive the workload and expose the /Flush/
// control the oracle needs.
//
// /Flush/ exists because a RocksDB readOnly:true open is a point-in-time snapshot of the SSTs as
// of that open, not a live view like LMDB's shared mmap, and Harper opens table/index column
// families with disableWAL defaulting true (resources/databases.ts openRocksDatabase), so a
// committed write can still sit only in the writer's memtable. Without an explicit flush an
// external reader reports a clean run from flush timing rather than from real consistency.
// `flushDatabases()` is not reachable from component code (security/jsLoader.ts exposes a
// curated allowlist), so this calls `.flush()` on a table's primaryStore instead; RocksDB's
// flush is atomic across every column family sharing the directory, so one call covers both
// tables and all their indices.

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
function getTable(name) {
	const t = tables[name];
	if (!t) throw new Error(`delete-index-atomicity-rocksdb: unknown table "${name}"`);
	return t;
}

// GET /Probe/ -> readiness poll target.
export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}

// GET /TableInfo/?table=X -> lets the test confirm the audit flag the arm depends on actually
// took effect, so a schema drift cannot turn this anchor quietly green for the wrong reason.
export class TableInfo extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const name = query?.get ? query.get('table') : query?.table;
		const t = getTable(name);
		return { table: name, audit: t.audit, hasAuditStore: !!t.auditStore };
	}
}

// POST /Flush/ -> force every column family to flush its memtable to SST so the external
// read-only oracle can observe writes already committed in this process.
export class Flush extends Resource {
	static loadAsInstance = false;
	async post() {
		const t = getTable('ItemF');
		if (typeof t.primaryStore.flush !== 'function')
			throw new Error('Flush control invalid: primaryStore.flush() not available (not RocksDB?)');
		await t.primaryStore.flush();
		return { ok: true };
	}
}

// POST /Seed/ { table, ids: [{id, category, value}] } -> plain, clean inserts.
export class Seed extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const rows = b.ids || [];
		for (const row of rows) {
			await t.put({ id: row.id, category: row.category, value: row.value ?? 'seed' });
		}
		return { ok: true, table: b.table, count: rows.length };
	}
}

// POST /DeleteOne/ { table, id } -> a single ordinary delete, no abort.
export class DeleteOne extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		await t.delete(b.id);
		return { ok: true, table: b.table, id: b.id };
	}
}

// POST /InjectPhantom/ { table, category, id } -> oracle positive control. Writes a raw index
// entry for an id that does not exist in the primary store, bypassing Table.ts's write path
// entirely, so the test can prove its external oracle actually detects a dangling entry (and
// that the search_by_value-style join cannot).
export class InjectPhantom extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const existing = t.primaryStore.getEntry(b.id);
		if (existing?.value) throw new Error(`InjectPhantom control invalid: id=${b.id} already exists in primary store`);
		await t.indices.category.put(b.category, b.id);
		return { ok: true, table: b.table, category: b.category, id: b.id, injected: true };
	}
}

// POST /RemoveIndexEntry/ { table, category, id } -> cleanup for InjectPhantom, so the
// deliberately-injected phantom cannot be mistaken for (or mask) a genuine one in the
// table-wide scans the later arms run against the same table.
export class RemoveIndexEntry extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		await t.indices.category.remove(b.category, b.id);
		return { ok: true, table: b.table, category: b.category, id: b.id, removed: true };
	}
}

// GET /BlindSearch/?table=X&category=Y -> the search_by_value-style join through the primary
// record, in-process, for direct contrast with the external raw-file oracle: it is structurally
// blind to a phantom because the join drops entries whose primary record is absent.
export class BlindSearch extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const name = query?.get ? query.get('table') : query?.table;
		const category = query?.get ? query.get('category') : query?.category;
		const t = getTable(name);
		const out = [];
		for await (const r of t.search({ conditions: [{ attribute: 'category', value: category }] })) {
			out.push({ id: r.id, category: r.category });
		}
		return { table: name, category, hits: out };
	}
}

// POST /DeleteThenAbort/ { table, id } -> Arm B: delete inside a transaction that then throws,
// which is #1854's original trigger shape.
export class DeleteThenAbort extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		await t.delete(b.id);
		throw new Error(`deliberate abort after delete (table=${b.table} id=${b.id})`);
	}
}

// POST /SlowMixedHold/ { table, insertIds, updateId, updateCategory, removeId, markerId, holdMs }
// Arm A: one long-lived write transaction that inserts, updates an indexed attribute, and
// removes, then holds an open monitor-tracked read iterator past storage.maxTransactionOpenTime
// so the background monitor — not the handler — aborts it mid-transaction. The trailing marker
// write probes whether the ambient transaction was actually poisoned.
export class SlowMixedHold extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const insertIds = b.insertIds || [];
		const updateId = b.updateId;
		const updateCategory = b.updateCategory;
		const removeId = b.removeId;
		const markerId = b.markerId;
		const holdMs = b.holdMs != null ? Number(b.holdMs) : 15_000;
		const t0 = Date.now();

		// Holding an open iterator over a pre-seeded bucket is what registers a read txn with the
		// long-transaction monitor; without it the monitor never supervises this transaction.
		const iter = t.search({ conditions: [{ attribute: 'category', value: '__seed__' }] })[Symbol.asyncIterator]();
		await iter.next();

		const applied = { inserted: [], updated: false, removed: false };
		let writeError = null;
		try {
			for (const row of insertIds) {
				try {
					await t.put({ id: row.id, category: row.category, value: 'inserted' });
					applied.inserted.push(row.id);
				} catch (e) {
					writeError = `insert ${row.id}: ${String((e && e.message) || e)}`;
					break;
				}
			}
			if (!writeError && updateId) {
				try {
					await t.put({ id: updateId, category: updateCategory, value: 'updated' });
					applied.updated = true;
				} catch (e) {
					writeError = `update ${updateId}: ${String((e && e.message) || e)}`;
				}
			}
			if (!writeError && removeId) {
				try {
					await t.delete(removeId);
					applied.removed = true;
				} catch (e) {
					writeError = `remove ${removeId}: ${String((e && e.message) || e)}`;
				}
			}
			await sleep(holdMs);
			let markerError = null;
			if (markerId) {
				try {
					await t.put({ id: markerId, category: 'MARKER', value: 'marker' });
				} catch (e) {
					markerError = String((e && e.message) || e);
				}
			}
			return {
				ok: !writeError,
				table: b.table,
				applied,
				writeError,
				markerId,
				markerError,
				elapsedMs: Date.now() - t0,
			};
		} finally {
			await iter.return?.();
		}
	}
}
