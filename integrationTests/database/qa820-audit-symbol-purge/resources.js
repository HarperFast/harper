export class Snapshot extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const store = tables.Purge820.auditStore;
		const decodeMarker = query?.get?.('decodeMarker') === 'true';
		if (decodeMarker) store.get(Symbol.for('last-removed'));
		const marker = store.getBinary(Symbol.for('last-removed'));
		return {
			enginePath: tables.Purge820.primaryStore?.path || tables.Purge820.primaryStore?.rootStore?.path || null,
			tableId: tables.Purge820.tableId,
			decodeMarker,
			markerByteLength: marker?.byteLength ?? null,
			entries: Array.from(store.getRange({ start: 1, limit: 64 }), (entry) => ({
				key: entry.key,
				tableId: entry.tableId,
				recordId: entry.recordId,
				type: entry.type,
			})),
		};
	}
}
