// Regression anchor for harper#1887 (fixes #1629) — starts_with on an @indexed string vs astral-plane continuation chars.
//
// GET /RawIndex/ -> [{ key, id }] every raw entry of the secondary index for `Catalog.name`,
// read DIRECTLY off the index store (composite [indexedValue, primaryKey] keys — see
// resources/RocksIndexStore.ts). This bypasses search_by_value/search_by_conditions
// entirely: those join index hits back through the primary store and SKIP silently on
// absence, so they can never by themselves reveal an index/base divergence. Reading the
// index store directly proves whether an astral-bearing row was actually WRITTEN into the
// index (ruling out a write-path bug) even when a bounded starts_with range query misses it
// (a read-path/query-bound bug).
export class RawIndex extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const entry of tables.Catalog.indices.name.getRange({ start: true, values: true })) {
			const ids = Array.isArray(entry.value) ? entry.value : [entry.value];
			for (const id of ids) out.push({ key: entry.key, id });
		}
		return out;
	}
}
