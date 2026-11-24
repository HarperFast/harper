import { isReadOnlyMode } from '../databases.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';

const log = harperLogger.forComponent('analytics').conditional;

const BATCH_SIZE = 1000;
const COMPACT_INTERVAL = 3600000;

interface CleanupState {
	from: number | false;
	compactAttemptedAt: number;
	needsCompaction: boolean;
	running: boolean;
}
const states = new WeakMap<object, CleanupState>();

const rest = () => new Promise(setImmediate);

/**
 * Removes rows keyed below `now - retentionMs` from a table whose primary keys start with a timestamp, so the
 * expired rows are always a key prefix. See resources/analytics/DESIGN.md.
 */
export async function cleanupExpiredAnalytics(
	table: { primaryStore: any },
	retentionMs: number,
	now = Date.now()
): Promise<void> {
	if (isReadOnlyMode()) return;
	const store = table.primaryStore;
	let state = states.get(store);
	if (!state) {
		state = { from: false, compactAttemptedAt: 0, needsCompaction: true, running: false };
		states.set(store, state);
	}
	if (state.running) return;
	state.running = true;
	try {
		const end = now - retentionMs;
		if (state.from !== false && end <= state.from) return;
		// The scan below starts at the first key, which steps over every tombstone an earlier process left.
		if (state.compactAttemptedAt === 0) await compactExpired(store, end, now, state);
		let start: unknown = state.from;
		for (;;) {
			const removals = [];
			let last: unknown;
			for (const key of store.getKeys({ start, end, limit: BATCH_SIZE })) {
				removals.push(store.remove(key));
				last = key;
			}
			if (removals.length === 0) break;
			const failure = (await Promise.allSettled(removals)).find((result) => result.status === 'rejected');
			state.needsCompaction = true;
			if (failure) {
				log.warn?.('Removing expired analytics failed', (failure as PromiseRejectedResult).reason);
				return;
			}
			if (removals.length < BATCH_SIZE) break;
			start = last;
			await rest();
		}
		state.from = end;
		if (state.needsCompaction && now - state.compactAttemptedAt >= COMPACT_INTERVAL) {
			await compactExpired(store, end, now, state);
		}
	} finally {
		state.running = false;
	}
}

async function compactExpired(store: any, end: number, now: number, state: CleanupState): Promise<void> {
	if (typeof store.compact !== 'function') return;
	state.compactAttemptedAt = now;
	try {
		await store.compact({ start: false, end });
		state.needsCompaction = false;
	} catch (error) {
		log.warn?.('Compacting expired analytics failed', error);
	}
}
