// QA-746 / F-218 fixture resources (promoted from qa-explorer P-529 arm (a)).
//
// Probe: readiness poll target (component pre-installed; caller polls this route until it
// stops 404ing instead of restarting HTTP workers, per the harness's known race).
//
// StorageEngineInfo: code-derived signal for which storage engine is actually backing the
// Ledger table, so the test HARD-ASSERTS the engine in effect rather than trusting that the
// HARPER_STORAGE_ENGINE env var was honored (resources/databases.ts `database()`: LMDB root
// stores open at a path ending in `.mdb`; RocksDB opens a bare directory).
//
export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}

export class StorageEngineInfo extends Resource {
	static loadAsInstance = false;
	async get() {
		const t = tables['Ledger'];
		if (!t) throw new Error('QA-746: table Ledger not found');
		const primaryPath = t.primaryStore?.path || t.primaryStore?.rootStore?.path || null;
		const looksLikeLmdbPath = typeof primaryPath === 'string' && primaryPath.endsWith('.mdb');
		const hasPurgeLogs = typeof t.primaryStore?.rootStore?.purgeLogs === 'function';
		return {
			primaryPath,
			looksLikeLmdbPath,
			hasPurgeLogs,
			engineGuess: looksLikeLmdbPath ? 'lmdb' : hasPurgeLogs ? 'rocksdb' : 'unknown',
		};
	}
}
