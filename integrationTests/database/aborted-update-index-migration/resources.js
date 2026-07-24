// QA-616 — aborted UPDATE that migrates an @indexed value (category: A -> B).
//
// The known F-147/F-149 instances are DELETE-shaped: Table.ts _writeDelete()'s audit:false commit
// branch calls removeEntry(primaryStore, existingEntry) with NO {transaction} option, unlike its
// sibling updateIndices(id, existingRecord, null, transaction && {transaction}) one line above,
// which IS transaction-scoped. This file targets the UPDATE path instead: does an @indexed value
// migration (remove old-value entry, add new-value entry) commit atomically with the primary
// record when the enclosing transaction aborts?
//
// UpdateThenAbort   — in-request throw AFTER the migrating put (mirrors QA-604's DeleteThenAbort).
// UpdateThenStall   — migrating put, then a deliberate stall past storage.maxTransactionOpenTime so
//                     the long-transaction monitor's abortDueToTimeout() fires mid-held-txn
//                     (resources/DatabaseTransaction.ts startMonitoringTxns/abortDueToTimeout).
// UpdateOK          — control: the SAME migration with no abort (A -> B should end with exactly one
//                     entry at B, none at A).
// RemoveFromPrimaryOnly — the POSITIVE CONTROL: injects a synthetic dangling entry, proving the
//                     direct-store oracle can detect one on this exact fixture before trusting a
//                     "clean" result on the update path.
//
// IndexDump / IndexRangeAll — the NON-BLIND oracle. D-230 ("oracle-masking fallacy"): Table.ts
// transformToEntries() joins every index hit through the primary record and SKIPs when the primary
// is absent, so search_by_value can never see a dangling entry. These read the raw secondary-index
// dbi directly (index.getRange(), same handle Table.ts's own TTL sweep and search.ts use), no join.
export class UpdateThenAbort extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		await tables.Widget.put({ id: b.id, category: b.newCategory, value: b.value ?? 'migrated' });
		throw new Error(`QA-616 deliberate abort after index-migrating update (id=${b.id} -> ${b.newCategory})`);
	}
}

export class UpdateThenStall extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const parsedStallMs = b.stallMs != null ? Number(b.stallMs) : NaN;
		const stallMs = Number.isInteger(parsedStallMs) && parsedStallMs > 0 ? parsedStallMs : 4000;
		await tables.Widget.put({ id: b.id, category: b.newCategory, value: b.value ?? 'migrated-stall' });
		await new Promise((resolve) => setTimeout(resolve, stallMs));
		// If the over-time monitor poisoned this transaction during the stall, this second write (or
		// the implicit commit at request end) should throw transactionOpenTooLongError.
		return { ok: true, stalled: stallMs };
	}
}

export class UpdateOK extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		await tables.Widget.put({ id: b.id, category: b.newCategory, value: b.value ?? 'migrated-ok' });
		return { ok: true };
	}
}

// POST /RemoveFromPrimaryOnly/ { id } — the synthetic positive-control mechanism (D-232): a normal
// put (durably indexed), then a primary-store-level remove that bypasses updateIndices() entirely,
// leaving a KNOWN-dangling raw index entry. Deliberately synthetic rather than reusing a real
// defect's mechanism (e.g. delete-then-abort, F-147): a control keyed to an open defect turns red
// the day that defect is fixed, which would make this file block its own fix PR.
export class RemoveFromPrimaryOnly extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const removed = await tables.Widget.primaryStore.remove(b.id);
		return { ok: true, removed, id: b.id };
	}
}

function qget(query, key) {
	if (!query) return undefined;
	return query.get ? query.get(key) : query[key];
}

// GET /IndexDump/?category=X -> raw ids under index key X, no primary join.
export class IndexDump extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const category = qget(query, 'category');
		const index = tables.Widget.indices.category;
		const ids = [
			...index.getRange({ start: category, end: category, inclusiveEnd: true, values: true, snapshot: false }),
		]
			.filter((entry) => entry.key === category)
			.map((entry) => entry.value);
		return { category, ids };
	}
}

// GET /IndexRangeAll/ -> every raw {key,value} pair in the whole category index, no primary join.
export class IndexRangeAll extends Resource {
	static loadAsInstance = false;
	async get() {
		const index = tables.Widget.indices.category;
		const entries = [...index.getRange({ values: true, snapshot: false })].map(({ key, value }) => ({
			key,
			value,
		}));
		return { count: entries.length, entries };
	}
}
