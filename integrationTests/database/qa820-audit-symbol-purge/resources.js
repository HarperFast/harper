export class Snapshot extends Resource {
	static loadAsInstance = false;
	async get() {
		const store = tables.Purge820.auditStore;
		const marker = store.getBinary(Symbol.for('last-removed'));
		return {
			enginePath: tables.Purge820.primaryStore?.path || tables.Purge820.primaryStore?.rootStore?.path || null,
			tableId: tables.Purge820.tableId,
			markerByteLength: marker?.byteLength ?? null,
			markerKeyCount: Array.from(store.getRange({ start: 0, end: 1, values: false })).length,
			entries: Array.from(store.getRange({ start: 1, limit: 64 }), (entry) => ({
				key: entry.key,
				tableId: entry.tableId,
				recordId: entry.recordId,
				type: entry.type,
			})),
		};
	}
}
