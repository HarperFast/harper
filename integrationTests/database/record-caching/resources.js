// A plain REST GET cannot say WHICH worker answered it, so the 4-worker suite has no way to tell
// "every worker serves the updated value" from "the one worker my connection was pinned to does".
// Both layers are returned per worker: `cached` is the per-worker WeakLRUCache entry a point-GET
// consults (resources/PrimaryRocksDatabase.ts), `read` is the same id through Table's read
// semantics, so staleness above getEntry is visible too.
import { threadId } from 'node:worker_threads';

const { CacheRecord } = tables;
const store = CacheRecord.primaryStore;

export class CacheRecordOnWorker extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const id = query && typeof query.get === 'function' ? query.get('id') : query?.id;
		const entry = store.getEntry(id);
		return {
			threadId,
			id,
			exists: entry != null,
			cached: entry?.value ?? null,
			read: (await CacheRecord.get(id)) ?? null,
		};
	}
}
