export class StorageEngineInfo extends Resource {
	static loadAsInstance = false;
	async get() {
		const store = databases.hr.Vault.primaryStore;
		const path = store?.path || store?.rootStore?.path || null;
		return { path, engine: typeof path === 'string' && path.endsWith('.mdb') ? 'lmdb' : 'rocksdb' };
	}
}
