// Workload drivers for delete-index-atomicity-rocksdb.test.ts. The oracle lives outside this
// process — the test opens raw read-only handles of its own — so these routes only drive the
// workload and publish the checkpoint the oracle reads.
//
// A readOnly:true open of the live directory races the compactions this process is running: it
// replays the MANIFEST into a file list and then opens those files holding no reference on any of
// them (HarperFast/rocksdb-js#812). /Snapshot/ hands the oracle a checkpoint instead, which nothing
// writes to. Its memtable flush is what makes the copy trustworthy: Harper opens table/index column
// families with disableWAL defaulting true (resources/databases.ts openRocksDatabase), so a
// committed write can otherwise sit only in this process's memtable and an external reader would
// report a clean run from flush timing rather than from real consistency.

import { resolve } from 'node:path';

const SNAPSHOT_DIR = 'oracle-snapshots';

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
function getTable(name) {
	const t = tables[name];
	if (!t) throw new Error(`delete-index-atomicity-rocksdb: unknown table "${name}"`);
	return t;
}

export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}

// Lets the test confirm the flags that select the delete branch each arm targets, so a schema
// drift cannot turn the anchor quietly green for the wrong reason.
export class TableInfo extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const name = query?.get ? query.get('table') : query?.table;
		const t = getTable(name);
		return { table: name, audit: t.audit, trackDeletes: !!t.trackDeletes, hasAuditStore: !!t.auditStore };
	}
}

// Moves the live database forward without touching the held checkpoint, so the test can prove that
// the next refresh replaces it with one containing the new write. The handle-path assertion proves
// that the oracle reads the checkpoint rather than the live directory.
// `flushDatabases()` is not reachable from component code (security/jsLoader.ts exposes a curated
// allowlist), so this calls `.flush()` on a table's primaryStore; RocksDB's flush is atomic across
// every column family sharing the directory, so one call covers both tables and all indices.
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

// The oracle's read target: a hardlinked, point-in-time copy of every column family, flushed as
// part of being taken (resources/branchDatabase.ts materializes application branches the same way).
// The target is derived here from the store's own path rather than taken from the request, so no
// caller can aim a native filesystem operation somewhere the test does not own or clean up. It sits
// beside `database/` rather than inside it, which is the only directory scanned for databases
// (resources/databases.ts), so a snapshot can never be loaded as one.
export class Snapshot extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const seq = b.seq;
		// Not Number(b.seq): that coerces true, null and [] to a valid-looking 1 or 0.
		if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0)
			throw new Error(`Snapshot control invalid: seq must be a non-negative integer, got ${JSON.stringify(b.seq)}`);
		const rootStore = getTable('ItemF').primaryStore.rootStore;
		if (typeof rootStore?.createCheckpoint !== 'function')
			throw new Error('Snapshot control invalid: rootStore.createCheckpoint() not available (not RocksDB?)');
		const path = resolve(rootStore.path, '..', '..', SNAPSHOT_DIR, String(seq));
		await rootStore.createCheckpoint(path);
		return { ok: true, path };
	}
}

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

export class DeleteOne extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		await t.delete(b.id);
		return { ok: true, table: b.table, id: b.id };
	}
}

// Oracle positive control: writes a raw index entry for an id that does not exist in the primary
// store, bypassing Table.ts's write path entirely, so the test can prove its external oracle
// detects a dangling entry — and that the join-based query surface does not.
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

// Cleanup for InjectPhantom, so the deliberate artifact cannot be mistaken for (or mask) a
// genuine phantom in the table-wide scans the later arms run against the same table.
export class RemoveIndexEntry extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		await t.indices.category.remove(b.category, b.id);
		return { ok: true, table: b.table, category: b.category, id: b.id, removed: true };
	}
}

// The search_by_value-style join through the primary record, for direct contrast with the
// external oracle: it is structurally blind to a phantom because the join drops entries whose
// primary record is absent.
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

// Arm B: #1854's original trigger shape.
export class DeleteThenAbort extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		await t.delete(b.id);
		throw new Error(`deliberate abort after delete (table=${b.table} id=${b.id})`);
	}
}

// Arm A: one long-lived write transaction that removes, inserts, and updates an indexed
// attribute, then holds an open monitor-tracked read iterator past storage.maxTransactionOpenTime
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

		const applied = { removed: false, inserted: [], updated: false };
		let writeError = null;
		try {
			await iter.next();
			// The remove goes first: it is the write whose transaction threading #1854 was about, so
			// no earlier write may fail and skip it, leaving the arm asserting on a workload that
			// never reached removeEntry().
			if (removeId) {
				try {
					await t.delete(removeId);
					applied.removed = true;
				} catch (e) {
					writeError = `remove ${removeId}: ${String((e && e.message) || e)}`;
				}
			}
			if (!writeError) {
				for (const row of insertIds) {
					try {
						await t.put({ id: row.id, category: row.category, value: 'inserted' });
						applied.inserted.push(row.id);
					} catch (e) {
						writeError = `insert ${row.id}: ${String((e && e.message) || e)}`;
						break;
					}
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
			// Fail fast and loudly rather than holding: a workload that never reached the writes still
			// trips the monitor, and the arm would then find no phantoms and pass without having
			// exercised the delete at all.
			if (writeError) throw new Error(`SlowMixedHold: workload write failed before the hold: ${writeError}`);

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
			// The monitor may already have torn the transaction down, in which case closing the
			// iterator throws; letting that escape would replace the response with an unrelated error.
			try {
				await iter.return?.();
			} catch {
				/* transaction already gone */
			}
		}
	}
}
