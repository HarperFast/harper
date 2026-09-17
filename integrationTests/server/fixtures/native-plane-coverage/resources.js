import { threadId } from 'node:worker_threads';

export class PlaneStatus extends Resource {
	static loadAsInstance = false;
	get(target) {
		const Table = tables.PlaneProbe;
		const store = Table.indices.vector;
		const index = store.customIndex;
		const readiness = index.derivedHost.readiness();
		let mappings = 0;
		let pending = 0;
		for (const { key, value } of store.getRange()) {
			if (typeof key !== 'number') continue;
			if (value.pending) pending++;
			else mappings++;
		}
		const tails = {};
		if (target.get('tails')) {
			for (const log of Table.auditStore.rootStore.listLogs()) {
				for (const entry of Table.auditStore.getRange({ start: 0, log })) {
					if (entry.endTxn) tails[log] = entry.txnLogKey;
				}
			}
		}
		return {
			threadId,
			readiness: { ...readiness, ownerEpoch: String(readiness.ownerEpoch) },
			cursor: store.getSync(Symbol.for('derived-index-cursor')),
			mappings,
			pending,
			tails,
			nativeNodes: index.getPlane()?.idHighWater(),
		};
	}
}

export class MappedPlane extends tables.PlaneProbe {
	static loadAsInstance = false;
	async allowRead() {
		return true;
	}
	search(target, query) {
		const results = super.search(query ?? target);
		return results.map((record) => record);
	}
}

export class ConcatenatedPlane extends tables.PlaneProbe {
	static loadAsInstance = false;
	search(target, query) {
		const results = super.search(query ?? target);
		return super
			.search({ limit: 1 })
			.map((record) => record)
			.concat(results);
	}
}
