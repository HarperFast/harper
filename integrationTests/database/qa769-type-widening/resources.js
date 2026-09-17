import { threadId } from 'node:worker_threads';

const { MeteredEvent } = tables;

// Magnitudes no float64 can carry, so they are only exact as BigInt literals — the only way to ask
// whether the widened `Long` holds a genuine 64-bit value rather than whatever JSON transport left.
const BIGINT_PROBES = {
	'2^53+1': 9007199254740993n,
	'2^63-1': 9223372036854775807n,
};

export class PutBigInt extends Resource {
	static loadAsInstance = false;

	// Nothing is caught here on purpose: a Long that refuses the value rejects the request, and the
	// suite asserts on that rejection. A `{ ok: true }` response therefore means the write was taken.
	async post(_query, body) {
		const count = BIGINT_PROBES[body.probe];
		if (count === undefined) throw new Error(`unknown BigInt probe ${body.probe}`);
		await MeteredEvent.put({ id: body.id, count, label: body.probe });
		return { ok: true };
	}
}

export class StorageEngineInfo extends Resource {
	static loadAsInstance = false;

	// Derived from the store rather than trusted from HARPER_STORAGE_ENGINE: if the engine pin were
	// ignored, both defineSuite arms would run RocksDB and the LMDB half would be green without ever
	// touching LMDB's record or index encoding. LMDB environments land at `<path>.mdb` and its index
	// stores expose `prefetch`; RocksDB does neither.
	async get() {
		const primaryStore = MeteredEvent.primaryStore;
		const primaryPath = primaryStore.path ?? primaryStore.rootStore?.path ?? '';
		const looksLikeLmdb = primaryPath.endsWith('.mdb') || Boolean(MeteredEvent.indices.count?.prefetch);
		return { engine: looksLikeLmdb ? 'lmdb' : 'rocksdb', primaryPath };
	}
}

export class IndexDump extends Resource {
	static loadAsInstance = false;

	// The secondary index's own entries, with no primary-store join. A range query alone cannot prove
	// the widened attribute is still indexed — resources/search.ts falls back to a full scan when it
	// is not — so this is where "the index holds exactly these rows" is actually checked.
	async get() {
		const index = MeteredEvent.indices.count;
		if (!index) throw new Error('MeteredEvent.count carries no secondary index');
		// No `snapshot: false` here: an index is a dupSort store under LMDB, which rejects that option.
		return [...index.getRange({})].map((entry) => ({ count: entry.key, id: entry.value }));
	}
}

export class DumpAll extends Resource {
	static loadAsInstance = false;

	// Index-independent oracle. `typeof` cannot survive JSON, so it is captured here; a stored bigint
	// would fail serialization outright, which PutBigInt's rejection arm is what rules out.
	async get() {
		const rows = [];
		for await (const record of MeteredEvent.search({})) {
			rows.push({
				id: record.id,
				count: record.count,
				countType: typeof record.count,
				label: record.label,
				labelType: typeof record.label,
			});
		}
		return rows;
	}
}

export class RowOnWorker extends Resource {
	static loadAsInstance = false;

	// A plain REST GET cannot say which worker answered it, so the cross-worker arm has no way to
	// tell "every worker decodes this record the same" from "the one worker I reached does".
	async get(query) {
		const record = await MeteredEvent.get(Number(query.get('id')));
		return {
			threadId,
			count: record.count,
			countType: typeof record.count,
			label: record.label,
			labelType: typeof record.label,
		};
	}
}
