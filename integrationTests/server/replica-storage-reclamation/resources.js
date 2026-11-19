// A stand-in for a sharded table's replication source: a read of a stub is answered by a "resident" and kept as a
// replica, the way harper-pro's Replicator does it. Core has no replication to fetch from.
const RESIDENCY_ID = 123;
const { Reclaimable } = databases.replicareclamation;

Reclaimable.dbisDB.putSync([Symbol.for('residency_by_id'), RESIDENCY_ID], ['resident-a']);
Reclaimable.sourcedFrom(
	class extends Resource {
		static async load(entry) {
			const answer = {
				key: entry.key,
				value: { id: entry.key, name: 'indexed', body: 'from the owner' },
				version: entry.version,
				originNode: server.hostname,
				fullWriteHead: entry.version,
			};
			await Reclaimable._storeReplica(entry, answer);
			return answer;
		}
	},
	{ intermediateSource: true }
);

export class ReplicaFixture extends Resource {
	static loadAsInstance = false;
	async post(_target, { ids }) {
		const context = this.getContext();
		for (const id of ids) {
			const row = await Reclaimable.getResource(id, context, { ensureLoaded: false });
			row._writeInvalidate(id, { name: 'indexed' }, { residencyId: RESIDENCY_ID });
		}
		return { stubs: ids.length };
	}
	// what the store holds, read without the table's read path, which would refetch a stub
	async get(query) {
		const id = query?.get ? query.get('id') : query?.id;
		const entry = Reclaimable.primaryStore.getEntry(id);
		return { name: entry?.value?.name ?? null, body: entry?.value?.body ?? null };
	}
}
