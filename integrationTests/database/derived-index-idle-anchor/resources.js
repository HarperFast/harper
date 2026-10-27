// What the suite needs that no operations-API surface exposes: the index's readiness and durable
// cursor, the transaction log's positions, and a flush so retention has fully flushed files to purge.

const table = () => tables.IdleProbe;

export class IdleStatus extends Resource {
	static loadAsInstance = false;
	get() {
		const Table = table();
		const store = Table.indices.vector;
		const readiness = store.customIndex.derivedHost.readiness();
		const stats = Table.auditStore.rootStore.useLog('local').getStats();
		return {
			readiness: { ...readiness, ownerEpoch: String(readiness.ownerEpoch) },
			cursor: store.getSync(Symbol.for('derived-index-cursor')),
			log: {
				fileCount: stats.fileCount,
				currentSequenceNumber: stats.currentSequenceNumber,
				lastCommittedPosition: stats.lastCommittedPosition,
				lastFlushedPosition: stats.lastFlushedPosition,
			},
		};
	}
}

export class IdleFlush extends Resource {
	static loadAsInstance = false;
	post() {
		table().auditStore.rootStore.flushSync();
		return { ok: true };
	}
}
