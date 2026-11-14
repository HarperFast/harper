import { threadId } from 'node:worker_threads';

// QA-431 — sub-second-TTL atomic counter resource.
//
// POST /RateIncrement/ { id } → atomically addTo('hits', 1) on RateCounter[id].
// No prior record required — update() upserts from scratch (count starts at 0+1=1).
// Returns { ok, id } on 200; throws propagate as 500.

export class RateIncrement extends Resource {
	static loadAsInstance = false;

	async post(query, body) {
		const id = (body && body.id) || 'default';
		const updatable = await tables.RateCounter.update(id, {});
		updatable.set('id', id);
		updatable.addTo('hits', 1);
		await updatable.save();
		return { ok: true, id };
	}
}

function copyEntry(entry) {
	if (!entry) return null;
	return {
		hits: entry.value?.hits ?? null,
		version: entry.version ?? null,
		localTime: entry.localTime ?? null,
		expiresAt: entry.expiresAt ?? null,
		metadataFlags: entry.metadataFlags ?? null,
		nodeId: entry.nodeId ?? null,
		additionalAuditRefs: (entry.additionalAuditRefs ?? []).map(({ version, nodeId }) => ({ version, nodeId })),
		receivedIdentityRefs: (entry.receivedIdentityRefs ?? []).map(({ version, nodeId }) => ({ version, nodeId })),
	};
}

export class RateSnapshot extends Resource {
	get() {
		const id = this.getId();
		const Table = tables.RateCounter;
		const transaction = Table._readTxnForContext(this.getContext());
		const nowBefore = Date.now();
		const transactionSnapshot = copyEntry(Table.primaryStore.getEntry(id, { transaction, uncachedRead: true }));
		const cached = copyEntry(Table.primaryStore.getEntry(id, { transaction }));
		return {
			id,
			threadId,
			nowBefore,
			nowAfter: Date.now(),
			engine: Table.primaryStore.encoder?.isRocksDB ? 'rocksdb' : 'other',
			uncachedReadBypassesCache: Table.primaryStore.isPrimaryRocksDatabase === true,
			transactionSnapshot,
			cached,
		};
	}
}
