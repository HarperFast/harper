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

export class IdleClear extends Resource {
	static loadAsInstance = false;
	async post() {
		await table().clear();
		return { ok: true };
	}
}
