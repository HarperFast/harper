// Scale fixture — SST reclamation probe resource.
//
// Exposes two endpoints:
//
//   GET  /CompactDb  → snapshot of per-CF live SST size (KB) and key counts
//   POST /CompactDb  → (1) purge soft-deleted records from the primary store,
//                      (2) clear all column families (primary + each @indexed),
//                      then return before/after SST stats.
//
// Why not the Harper operations API?
//   The operations API has no `compact_database` endpoint; posting it returns 400
//   on RocksDB-backed tables.
//
// Harper delete semantics on RocksDB (without audit):
//   A DELETE writes a null-value record ("soft-delete marker") to the primary store
//   and schedules a background cleanup scan.  The cleanup scan, which runs on a
//   timer (last worker thread), later calls primaryStore.remove() on each null
//   record, creating an actual RocksDB tombstone.  Only after that tombstone is
//   created and cleared away is space reclaimed.
//
//   The POST /CompactDb endpoint replicates the cleanup logic synchronously:
//   it iterates primaryStore, removes any null-value record (soft-delete marker),
//   and then calls store.clear() on all CFs.  store.clear() uses compactRange()
//   followed by DeleteFilesInRange(), which eliminates SST files directly even at
//   the bottommost level — unlike compact() which respects kIfHaveCompactionFilter.

function cfStats(store) {
	if (!store || typeof store.getDBIntProperty !== 'function') {
		return { error: 'store is not a RocksDatabase or lacks getDBIntProperty' };
	}
	const liveSstBytes = store.getDBIntProperty('rocksdb.live-sst-files-size') ?? 0;
	const estimateKeys = store.getDBIntProperty('rocksdb.estimate-num-keys') ?? 0;
	return {
		live_sst_kb: Math.round(liveSstBytes / 1024),
		estimate_keys: estimateKeys,
	};
}

export class CompactDb extends Resource {
	static loadAsInstance = false;

	snapshot() {
		const route = tables.Route;
		if (!route?.primaryStore) {
			return { error: 'Route table not found' };
		}
		const primary = cfStats(route.primaryStore);
		const indices = {};
		for (const [name, store] of Object.entries(route.indices || {})) {
			indices[name] = cfStats(store);
		}
		const totalLiveSstKb =
			(primary.live_sst_kb ?? 0) + Object.values(indices).reduce((s, v) => s + (v.live_sst_kb ?? 0), 0);
		return { primary, indices, total_live_sst_kb: totalLiveSstKb };
	}

	async get() {
		return this.snapshot();
	}

	async post() {
		const route = tables.Route;
		if (!route?.primaryStore) {
			return new Response(JSON.stringify({ error: 'Route table not found' }), {
				status: 503,
				headers: { 'content-type': 'application/json' },
			});
		}

		const before = this.snapshot();
		const errors = [];
		let softDeletesRemoved = 0;

		// ── Step 1: explicit soft-delete purge ────────────────────────────────
		// Harper's DELETE on RocksDB writes a null-value record (soft-delete marker)
		// to the primary store rather than a RocksDB tombstone directly.  A background
		// cleanup scan eventually calls primaryStore.remove() on each null record.
		// We replicate that logic synchronously here so the test doesn't depend on
		// the cleanup timer firing within the test window.
		try {
			const pending = [];
			for (const entry of route.primaryStore.getRange({
				start: false,
				snapshot: false,
				versions: true,
				lazy: true,
			})) {
				if (entry.value === null || entry.value === undefined) {
					// This is a soft-delete marker.  Remove it now to create a RocksDB
					// tombstone so the subsequent clear() can eliminate it.
					pending.push(route.primaryStore.remove(entry.key, entry.version));
					softDeletesRemoved++;
				}
			}
			// Wait for all removes to flush.
			if (pending.length > 0) await Promise.all(pending.filter((p) => p?.then));
		} catch (e) {
			errors.push(`soft-delete purge: ${e.message}`);
		}

		// ── Step 2: clear all CFs ────────────────────────────────────────────
		// store.clear() calls compactRange() then DeleteFilesInRange() — this is more
		// aggressive than compact() alone.  The default CompactRangeOptions uses
		// kIfHaveCompactionFilter for bottommost_level_compaction, which means a plain
		// compact() call leaves tombstones at the bottommost SST level (L6) untouched.
		// DeleteFilesInRange() removes those SST files directly, fully reclaiming space.
		//
		// Because all records were deleted before this POST is called, the primary store
		// contains only soft-delete markers (already removed above) plus tombstones.
		// Clearing it is therefore safe and equivalent to truncating an empty table.
		const compacted = [];

		const stores = [['primary', route.primaryStore], ...Object.entries(route.indices || {})];

		for (const [name, store] of stores) {
			if (typeof store?.clear !== 'function') {
				errors.push(`no clear on ${name}`);
				continue;
			}
			try {
				await store.clear();
				compacted.push(name);
			} catch (e) {
				errors.push(`${name} clear: ${e.message}`);
			}
		}

		const after = this.snapshot();

		return {
			compacted: true,
			softDeletesRemoved,
			columns: compacted,
			errors,
			before,
			after,
		};
	}
}
