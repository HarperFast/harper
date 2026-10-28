// LMDB opens its root store at a path ending in `.mdb`, RocksDB at a bare directory.
export class StorageEngineInfo extends Resource {
	static loadAsInstance = false;
	get() {
		const store = tables.Stream.primaryStore;
		const path = store?.path || store?.rootStore?.path || null;
		return { path, engine: typeof path === 'string' && path.endsWith('.mdb') ? 'lmdb' : 'rocksdb' };
	}
}

// A save that takes longer than the gap between acknowledgements keeps the session saving, as a contended disk does.
// Unslowed, a save is shorter than the gap at 200 msg/s and the session goes idle between acknowledgements.
const sessions = databases.system.hdb_durable_session;
const put = sessions.put;
let latencyMs = 0;
sessions.put = async function (...args) {
	if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
	return put.apply(this, args);
};

export class SessionWriteLatency extends Resource {
	static loadAsInstance = false;
	post(_target, data) {
		latencyMs = data.ms;
		return { ms: latencyMs };
	}
}
