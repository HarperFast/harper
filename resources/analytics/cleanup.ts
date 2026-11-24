import { isReadOnlyMode } from '../databases.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';

const log = harperLogger.forComponent('analytics').conditional;

const BATCH_SIZE = 1000;
const COMPACT_INTERVAL = 3600000;

interface CleanupState {
	from: unknown;
	completedEnd: number;
	canCompact: boolean;
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
		const canCompact = typeof store.compact === 'function';
		state = {
			from: false,
			completedEnd: -Infinity,
			canCompact,
			compactAttemptedAt: 0,
			needsCompaction: canCompact,
			running: false,
		};
		states.set(store, state);
	}
	if (state.running) return;
	state.running = true;
	try {
		const end = now - retentionMs;
		if (end > state.completedEnd) {
			if (state.needsCompaction && state.compactAttemptedAt === 0) await compactExpired(store, end, now, state);
			if (!(await removeExpired(store, end, state))) return;
		}
		if (state.needsCompaction && now - state.compactAttemptedAt >= COMPACT_INTERVAL) {
			await compactExpired(store, state.completedEnd, now, state);
		}
	} finally {
		state.running = false;
	}
}

async function removeExpired(store: any, end: number, state: CleanupState): Promise<boolean> {
	for (;;) {
		let failure: unknown;
		const removals = [];
		let last: unknown;
		for (const key of store.getKeys({ start: state.from, end, limit: BATCH_SIZE })) {
			removals.push(
				Promise.resolve(store.remove(key)).then(
					() => {},
					(error) => {
						failure ??= error ?? new Error('Removal failed');
					}
				)
			);
			last = key;
		}
		if (removals.length > 0) {
			await Promise.all(removals);
			state.needsCompaction = state.canCompact;
			if (failure) {
				log.warn?.('Removing expired analytics failed', failure);
				return false;
			}
		}
		if (removals.length < BATCH_SIZE) break;
		state.from = last;
		await rest();
	}
	state.from = end;
	state.completedEnd = end;
	return true;
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
