// QA-751 — drives the workload (writes on both sides of the upgrade, planted phantom positive
// control). The oracle itself lives OUTSIDE this process: the test file opens the raw
// {dataRootDir}/database/data.mdb LMDB env directly with a second, independent, read-only
// handle and reads the FK index dbis (Order/customerId, LineItem/orderId) itself. These
// resources only drive writes / plant the phantom; they do not implement the oracle.

function getTable(name) {
	const t = tables[name];
	if (!t) throw new Error(`QA-751: unknown table "${name}"`);
	return t;
}

// GET /Probe/ -> readiness poll target.
export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}

// POST /Put/ { table, record } -> plain upsert, used to seed rows on both sides of the upgrade
// (pre-upgrade target rows, post-upgrade referencing rows, and vice versa).
export class Put extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		await t.put(b.record);
		return { ok: true, table: b.table, id: b.record.id };
	}
}

// POST /InjectPhantom/ { table, attribute, value, id } -> ORACLE POSITIVE CONTROL. Writes a raw
// index entry directly into the named FK index dbi for an id that does NOT exist in that
// table's primary store, entirely bypassing Table.ts's write path (no primaryStore.put, no
// updateIndices call site). Proves the raw external oracle can actually see a dangling entry
// when one truly exists.
export class InjectPhantom extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		const existing = t.primaryStore.getEntry(b.id);
		if (existing?.value)
			throw new Error(`QA-751 InjectPhantom control invalid: id=${b.id} already exists in ${b.table} primary store`);
		await t.indices[b.attribute].put(b.value, b.id);
		return { ok: true, table: b.table, attribute: b.attribute, value: b.value, id: b.id, injected: true };
	}
}

// POST /RemoveIndexEntry/ { table, attribute, value, id } -> cleanup for InjectPhantom's
// positive control so it does not contaminate later table-wide phantom scans.
export class RemoveIndexEntry extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const t = getTable(b.table);
		await t.indices[b.attribute].remove(b.value, b.id);
		return { ok: true, table: b.table, attribute: b.attribute, value: b.value, id: b.id, removed: true };
	}
}
