export class Churn extends Resource {
	static loadAsInstance = false;
	async post(_query, body) {
		const count = Number(body?.count);
		const payload = String(body?.payload || '');
		if (!Number.isSafeInteger(count) || count < 1) throw new Error('count must be a positive integer');
		for (let sequence = 0; sequence < count; sequence++) {
			await tables.Telemetry.put({ id: 'hot-record', sequence, payload });
		}
		return { count };
	}
}

export class Flush extends Resource {
	static loadAsInstance = false;
	async post() {
		const table = tables.Telemetry;
		if (!table || typeof table.primaryStore.flush !== 'function') {
			throw new Error('Telemetry primaryStore.flush() is unavailable');
		}
		await table.primaryStore.flush();
		return { flushed: true };
	}
}

export class ReclaimState extends Resource {
	static loadAsInstance = false;
	async get() {
		const table = tables.Telemetry;
		if (!table) throw new Error('Telemetry table is unavailable');
		const primaryPath = table.primaryStore?.path || table.primaryStore?.rootStore?.path || null;
		const looksLikeLmdbPath = typeof primaryPath === 'string' && primaryPath.endsWith('.mdb');
		const hasPurgeLogs = typeof table.primaryStore?.rootStore?.purgeLogs === 'function';
		const stats = table.auditStore?.log?.getStats?.();
		if (!stats) throw new Error('Telemetry transaction-log statistics are unavailable');
		return {
			engineGuess: looksLikeLmdbPath ? 'lmdb' : hasPurgeLogs ? 'rocksdb' : 'unknown',
			oldestSequenceNumber: stats.oldestSequenceNumber,
			currentSequenceNumber: stats.currentSequenceNumber,
			lastFlushedSequence: stats.lastFlushedPosition?.sequence,
			purgeRuns: stats.totals?.purgeRuns,
		};
	}
}

// Retire background cleanup during component load so any later purge is attributable to restart replay.
tables.Telemetry.auditStore.stopAuditCleanup();
