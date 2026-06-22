/**
 * Coverage for the HNSW custom-index storage-format migration path.
 *
 * A custom-index object store is either VERSIONED (each node value carries a monotonic version the
 * RocksDB Verification Table can extract → cached, decode-free traversal) or LEGACY (un-versioned).
 * The format is decided ONCE at index create and persisted on the attribute descriptor
 * (`indexFormat`), so every worker and every reload reads the same authoritative value rather than
 * re-deriving it from the store's current contents — which would race a concurrent backfill (a
 * store that is non-empty mid-build would be mis-read as legacy). A legacy index upgrades to
 * versioned only via an explicit reindex (a full rebuild from scratch). The HNSW_NO_AUTOVERSION
 * kill-switch blocks a NEW index from initializing as versioned, but never downgrades an
 * already-versioned store (so its reads stay correct).
 *
 * See resolveIndexFormat / armVersionedIndexEncoder and the reindex-upgrade branch in databases.ts.
 */
require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table, resetDatabases } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

async function fromAsync(iterable) {
	const out = [];
	for await (const value of iterable) out.push(value);
	return out;
}

// The per-attribute descriptor is persisted in Table.dbisDB keyed by `tableName/attributeName`.
// Look it up by exact key — these tests share the attribute name `vector` across several tables in
// the same database, so a name-only scan would return the wrong table's descriptor.
function descriptorFor(Tbl, tableName, attrName) {
	return Tbl.dbisDB.getSync(`${tableName}/${attrName}`);
}

describe('HNSW index format migration', () => {
	if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') return; // HNSW custom index is RocksDB-only here

	const DB = 'test';
	const N = 12;
	// Well-separated, non-degenerate vectors so each record's exact vector is unambiguously its own
	// nearest neighbour under euclidean distance — the search assertions check decode integrity
	// (no corruption), not recall, so the graph must not have ties.
	const vec = (i) => [i * 7 + 1, i * 3 + 2, i * 5 + 3, i * 2 + 5];

	// Reload the table WITH the index (resetDatabases first so table() re-opens from disk). A rebuild
	// is detected by table() installing a new indexingOperation promise.
	function reload(TABLE, indexedOption) {
		resetDatabases();
		return table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', indexed: indexedOption, type: 'Array' },
			],
		});
	}

	// Create the table with NO index yet and seed rows for the index backfill to consume.
	function seed(TABLE) {
		const Tbl = table({
			table: TABLE,
			database: DB,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vector', type: 'Array' },
			],
		});
		let last;
		for (let i = 0; i < N; i++) last = Tbl.put({ id: i, vector: vec(i) });
		return last;
	}

	async function countSearchMisses(Tbl) {
		let misses = 0;
		for (let i = 0; i < N; i++) {
			const results = await fromAsync(
				Tbl.search({ sort: { attribute: 'vector', target: vec(i), distance: 'euclidean' }, select: ['id'], limit: 5 })
			);
			if (!results.some((r) => r.id === i)) misses++;
		}
		return misses;
	}

	it('initializes a fresh index as versioned, persists indexFormat, and arms the encoder', async () => {
		const TABLE = 'FmtFresh';
		setupTestDBPath();
		setMainIsWorker(true);
		await seed(TABLE);

		const Tbl = reload(TABLE, { type: 'HNSW', M: 16 });
		assert.ok(Tbl.indexingOperation, 'adding @indexed over existing rows should schedule a backfill');
		await Tbl.indexingOperation;

		assert.equal(
			descriptorFor(Tbl, TABLE, 'vector').indexFormat,
			'versioned',
			'a fresh index should persist indexFormat=versioned'
		);
		assert.equal(Tbl.indices.vector.encoder.autoVersion, true, 'the versioned index encoder should be armed');
		assert.equal(await countSearchMisses(Tbl), 0, 'versioned index should find all records');
	});

	it('reads the persisted versioned format on reload instead of re-deriving it from a non-empty store', async () => {
		const TABLE = 'FmtReload';
		setupTestDBPath();
		setMainIsWorker(true);
		await seed(TABLE);
		let Tbl = reload(TABLE, { type: 'HNSW', M: 16 });
		await Tbl.indexingOperation;
		assert.equal(descriptorFor(Tbl, TABLE, 'vector').indexFormat, 'versioned');

		// Reload with no structural change: the store is now non-empty (the case the old empty-guard
		// would have mis-read as legacy), so this proves the format is read from disk, not re-probed.
		Tbl = reload(TABLE, { type: 'HNSW', M: 16 });
		assert.equal(
			descriptorFor(Tbl, TABLE, 'vector').indexFormat,
			'versioned',
			'reload should keep the persisted versioned format'
		);
		assert.equal(Tbl.indices.vector.encoder.autoVersion, true, 'reload should re-arm the versioned encoder');
		assert.equal(await countSearchMisses(Tbl), 0, 'versioned index should remain searchable after reload');
	});

	it('honors the HNSW_NO_AUTOVERSION kill-switch by initializing a fresh index as legacy', async () => {
		const TABLE = 'FmtKill';
		setupTestDBPath();
		setMainIsWorker(true);
		await seed(TABLE);

		process.env.HNSW_NO_AUTOVERSION = '1';
		try {
			const Tbl = reload(TABLE, { type: 'HNSW', M: 16 });
			await Tbl.indexingOperation;
			assert.equal(
				descriptorFor(Tbl, TABLE, 'vector').indexFormat,
				'legacy',
				'kill-switch should initialize a fresh index as legacy'
			);
			assert.ok(!Tbl.indices.vector.encoder.autoVersion, 'legacy index encoder must not be armed');
			assert.equal(await countSearchMisses(Tbl), 0, 'legacy index should still be searchable');
		} finally {
			delete process.env.HNSW_NO_AUTOVERSION;
		}
	});

	it('treats a falsy HNSW_NO_AUTOVERSION value ("false"/"0") as NOT set (env strings are truthy)', async () => {
		const TABLE = 'FmtKillFalsy';
		setupTestDBPath();
		setMainIsWorker(true);
		await seed(TABLE);

		process.env.HNSW_NO_AUTOVERSION = 'false';
		try {
			const Tbl = reload(TABLE, { type: 'HNSW', M: 16 });
			await Tbl.indexingOperation;
			assert.equal(
				descriptorFor(Tbl, TABLE, 'vector').indexFormat,
				'versioned',
				'HNSW_NO_AUTOVERSION="false" must not disable versioning'
			);
		} finally {
			delete process.env.HNSW_NO_AUTOVERSION;
		}
	});

	it('upgrades a legacy index to versioned on an explicit reindex', async () => {
		const TABLE = 'FmtUpgrade';
		setupTestDBPath();
		setMainIsWorker(true);
		await seed(TABLE);

		// Build a legacy index (kill-switch on only for the initial create).
		process.env.HNSW_NO_AUTOVERSION = '1';
		let Tbl;
		try {
			Tbl = reload(TABLE, { type: 'HNSW', M: 16 });
			await Tbl.indexingOperation;
			assert.equal(descriptorFor(Tbl, TABLE, 'vector').indexFormat, 'legacy', 'precondition: index built legacy');
			assert.ok(!Tbl.indices.vector.encoder.autoVersion, 'precondition: legacy encoder not armed');
		} finally {
			delete process.env.HNSW_NO_AUTOVERSION;
		}

		// Explicit reindex via a genuine option change (M 16 → 32) → full rebuild from scratch → upgrade.
		const upgraded = reload(TABLE, { type: 'HNSW', M: 32 });
		assert.ok(upgraded.indexingOperation, 'an option change must re-trigger a backfill');
		await upgraded.indexingOperation;

		assert.equal(
			descriptorFor(upgraded, TABLE, 'vector').indexFormat,
			'versioned',
			'an explicit reindex should upgrade legacy → versioned'
		);
		assert.equal(upgraded.indices.vector.encoder.autoVersion, true, 'the upgraded index encoder should be armed');
		assert.equal(await countSearchMisses(upgraded), 0, 'upgraded index should be searchable with no corruption');
	});

	// Regression: a format resolved by the initializer must be PERSISTED even when nothing else
	// changed. An index created before the indexFormat field existed has a descriptor with no
	// indexFormat; on first load its (empty) store resolves to 'versioned'. If that resolution were
	// not persisted, a later load — once the store is non-empty — would re-derive 'legacy' and open
	// the versioned nodes with the legacy decoder (silent corruption).
	it('persists an initializer-resolved format for a pre-existing descriptor that lacks indexFormat', async () => {
		const TABLE = 'FmtBackfill';
		setupTestDBPath();
		setMainIsWorker(true);

		// Create the index on an empty table; a fresh index persists indexFormat=versioned.
		let Tbl = reload(TABLE, { type: 'HNSW', M: 16 });
		assert.equal(descriptorFor(Tbl, TABLE, 'vector').indexFormat, 'versioned');

		// Simulate the pre-feature on-disk state: a descriptor with NO indexFormat over a still-empty
		// store. (Strip the field and write it back; the store has no nodes yet.)
		const stripped = { ...descriptorFor(Tbl, TABLE, 'vector') };
		delete stripped.indexFormat;
		Tbl.dbisDB.putSync(`${TABLE}/vector`, stripped);
		assert.equal(descriptorFor(Tbl, TABLE, 'vector').indexFormat, undefined, 'precondition: indexFormat stripped');

		// Reload with no structural change: the initializer resolves versioned (empty store) and must
		// PERSIST it (formatNeedsPersist), not just hold it in memory.
		Tbl = reload(TABLE, { type: 'HNSW', M: 16 });
		assert.equal(
			descriptorFor(Tbl, TABLE, 'vector').indexFormat,
			'versioned',
			'a no-change reload must persist the initializer-resolved format'
		);

		// Now write a few nodes (versioned) and reload once more: the persisted format keeps it versioned
		// even though the store is non-empty — the exact sequence that would silently corrupt without the
		// fix. A small, well-separated set keeps the tiny graph at perfect recall so a miss can only mean
		// the versioned nodes were read with the wrong (legacy) decoder, not a recall artifact.
		let last;
		for (let i = 0; i < 3; i++) last = Tbl.put({ id: i, vector: vec(i) });
		await last;
		Tbl = reload(TABLE, { type: 'HNSW', M: 16 });
		assert.equal(descriptorFor(Tbl, TABLE, 'vector').indexFormat, 'versioned', 'non-empty store stays versioned');
		assert.equal(Tbl.indices.vector.encoder.autoVersion, true, 'encoder re-armed versioned');
		for (let i = 0; i < 3; i++) {
			const results = await fromAsync(
				Tbl.search({ sort: { attribute: 'vector', target: vec(i), distance: 'euclidean' }, select: ['id'], limit: 5 })
			);
			assert.ok(
				results.some((r) => r.id === i),
				`versioned node ${i} decodes and is findable after the round-trip (no decoder mismatch)`
			);
		}
	});
});
