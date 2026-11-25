import { isReadOnlyMode } from '../databases.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';

const log = harperLogger.forComponent('analytics').conditional;

const BATCH_SIZE = 1000;
const COMPACT_INTERVAL = 3600000;

interface CleanupState {
	from: unknown;
	completedEnd: number;
	deletedBelow: number;
	canCompact: boolean;
	compactAttemptedAt: number;
	needsCompaction: boolean;
	running: boolean;
}
const states = new WeakMap<object, CleanupState>();

const rest = () => new Promise(setImmediate);

/** Requires primary keys that start with a timestamp. See resources/analytics/DESIGN.md. */
export async function cleanupExpiredAnalytics(
	table: { primaryStore: any },
	retentionMs: number,
	now = Date.now()
): Promise<void> {
	if (isReadOnlyMode()) return;
	const store = table.primaryStore;
	let state = states.get(store);
	if (!state) {
		const canCompact = typeof store.compact === 'function';
		state = {
			from: false,
			completedEnd: -Infinity,
			deletedBelow: -Infinity,
			canCompact,
			compactAttemptedAt: 0,
			needsCompaction: canCompact,
			running: false,
		};
		states.set(store, state);
	}
	if (state.running) return;
	state.running = true;
	const current = () => !isReadOnlyMode() && table.primaryStore === store;
	try {
		const end = now - retentionMs;
		if (end > state.completedEnd) {
			if (state.needsCompaction && state.compactAttemptedAt === 0) await compactExpired(store, end, now, state);
			if (!current()) return;
			await removeExpired(store, end, state, current);
		}
		if (!current()) return;
		if (state.needsCompaction && now - state.compactAttemptedAt >= COMPACT_INTERVAL) {
			await compactExpired(store, Math.max(end, state.deletedBelow), now, state);
		}
	} finally {
		state.running = false;
	}
}

async function removeExpired(store: any, end: number, state: CleanupState, current: () => boolean): Promise<void> {
	for (;;) {
		let failure: unknown;
		const onFailure = (error: unknown) => {
			failure ??= error ?? new Error('Removal failed');
		};
		const pending: Promise<unknown>[] = [];
		let count = 0;
		let last: unknown;
		try {
			for (const key of store.getKeys({ start: state.from, end, limit: BATCH_SIZE })) {
				count++;
				last = key;
				try {
					const result = store.remove(key);
					if (typeof result?.then === 'function') pending.push(result.then(undefined, onFailure));
				} catch (error) {
					onFailure(error);
					break;
				}
			}
		} catch (error) {
			onFailure(error);
		} finally {
			await Promise.all(pending);
			if (count > 0) {
				state.needsCompaction = state.canCompact;
				state.deletedBelow = Math.max(state.deletedBelow, end);
			}
		}
		if (failure) {
			log.warn?.('Removing expired analytics failed', failure);
			return;
		}
		if (count < BATCH_SIZE) break;
		state.from = last;
		await rest();
		if (!current()) return;
	}
	state.from = end;
	state.completedEnd = end;
}

async function compactExpired(store: any, end: number, now: number, state: CleanupState): Promise<void> {
	state.compactAttemptedAt = now;
	try {
		await store.compact({ start: false, end });
		state.needsCompaction = false;
	} catch (error) {
		log.warn?.('Compacting expired analytics failed', error);
	}
}
