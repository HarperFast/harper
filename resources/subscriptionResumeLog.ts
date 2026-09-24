import { setImmediate as rest } from 'node:timers/promises';
import type { AuditRecord } from './auditStore.ts';
import type { RocksTransactionLogStore, TransactionLogIterable } from './RocksTransactionLogStore.ts';
import {
	SubscriptionResumeError,
	SubscriptionResumeState,
	subscriptionResumeFingerprint,
	validateResumeTimestamp,
	type SubscriptionResumeOptions,
} from './subscriptionResumeState.ts';

export type SubscriptionResumeLogOptions = SubscriptionResumeOptions & {
	localNodeName: string;
	startTime: number;
	resumeState: string;
	maxEntries?: number;
	signal?: AbortSignal;
};

const scanning = new WeakSet<object>();

function checkRange(range: TransactionLogIterable): void {
	if (range.corruptFrameStop.breaks || range.failedLogs.size || range.exactStartFailures.size)
		throw new SubscriptionResumeError('transaction log history is incomplete or unreadable');
}

function checkEntry(entry: AuditRecord): void {
	if (!entry.type || entry.type === 'reload')
		throw new SubscriptionResumeError('transaction log contains unreadable or replaced state');
	validateResumeTimestamp(entry.txnLogKey);
}

function checkHistory(store: RocksTransactionLogStore, origins: Set<string>, localNodeName: string): string[] {
	const names = store.rootStore.listLogs();
	const resolved = new Set<string>();
	for (const name of names) {
		const origin = name === 'local' ? localNodeName : name;
		if (!origins.has(origin) || resolved.has(origin)) throw new SubscriptionResumeError('origin membership changed');
		resolved.add(origin);
		const stats = store.rootStore.useLog(name).getStats();
		if (stats.oldestSequenceNumber !== 1 && !(stats.fileCount === 0 && stats.currentSequenceNumber <= 1))
			throw new SubscriptionResumeError('transaction log no longer retains its beginning');
	}
	return names.sort();
}

/** Internal prototype: caller must establish common physical history, authorize, and own snapshot/live handoff. */
export async function openSubscriptionResumeLog(
	store: RocksTransactionLogStore,
	options: SubscriptionResumeLogOptions
): Promise<IterableIterator<AuditRecord>> {
	const origins = Array.from(options.origins);
	new SubscriptionResumeState({ ...options, origins });
	if (!origins.includes(options.localNodeName)) throw new TypeError('The local node must be a resume origin');
	const { startTime, window, historyId, resumeState, signal } = options;
	if (!Number.isFinite(startTime) || startTime < 0 || startTime + window > 8.64e15)
		throw new TypeError('Invalid subscription resume startTime');
	if (typeof resumeState !== 'string' || !/^1\.[A-Za-z0-9_-]{22}$/.test(resumeState))
		throw new SubscriptionResumeError('invalid resumeState');
	const maxEntries = options.maxEntries ?? 100_000;
	if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0)
		throw new TypeError('maxEntries must be a positive integer');
	if (scanning.has(store.rootStore)) throw new SubscriptionResumeError('resume validation is already running');
	signal?.throwIfAborted();
	const originSet = new Set(origins);
	const names = checkHistory(store, originSet, options.localNodeName);
	const registry = JSON.stringify(names);
	const states = new Map<string, 'active' | number | null>(origins.map((origin) => [origin, null]));
	const anchors = new Map<string, number>();
	let inspected = 0;
	let range: TransactionLogIterable | undefined;
	let iterator: Iterator<AuditRecord> | undefined;
	scanning.add(store.rootStore);
	try {
		for (const name of names) {
			range = store.getRange({ log: name, start: 0 });
			iterator = range[Symbol.iterator]();
			let pending: number | undefined;
			let firstInWindow: number | undefined;
			let lastBeforeWindow: number | null = null;
			const timestamps = new Set<number>();
			for (let result = iterator.next(); !result.done; result = iterator.next()) {
				if (++inspected > maxEntries) throw new SubscriptionResumeError('resume validation entry budget exceeded');
				const entry = result.value;
				checkEntry(entry);
				if (pending !== undefined && pending !== entry.txnLogKey)
					throw new SubscriptionResumeError('incomplete transaction');
				pending = entry.txnLogKey;
				if (entry.endTxn) {
					if (timestamps.has(pending)) throw new SubscriptionResumeError('ambiguous transaction timestamp');
					timestamps.add(pending);
					if (pending >= startTime && pending <= startTime + window) firstInWindow ??= pending;
					if (pending < startTime) lastBeforeWindow = pending;
					pending = undefined;
				}
				if (inspected % 1024 === 0) {
					await rest(undefined, { signal });
					signal?.throwIfAborted();
				}
			}
			checkRange(range);
			if (pending !== undefined) throw new SubscriptionResumeError('incomplete transaction');
			const origin = name === 'local' ? options.localNodeName : name;
			states.set(origin, firstInWindow === undefined ? lastBeforeWindow : 'active');
			const anchor = firstInWindow ?? lastBeforeWindow;
			if (anchor !== null) anchors.set(name, anchor);
			iterator.return?.();
			iterator = undefined;
		}
		if (subscriptionResumeFingerprint(historyId, window, states) !== resumeState)
			throw new SubscriptionResumeError('resumeState does not match this history');
		if (JSON.stringify(checkHistory(store, originSet, options.localNodeName)) !== registry)
			throw new SubscriptionResumeError('transaction log membership changed during validation');
		signal?.throwIfAborted();
		range = store.getRange({ startByLog: anchors, exactStart: true, exclusiveStart: false, includeLogName: true });
		iterator = range[Symbol.iterator]();
		checkRange(range);
		const replayRange = range;
		const replayIterator = iterator;
		const pending = new Map<string, number>();
		let closed = false;
		const reader: IterableIterator<AuditRecord> = {
			[Symbol.iterator]() {
				return this;
			},
			next() {
				if (closed) return { done: true, value: undefined };
				try {
					signal?.throwIfAborted();
					if (JSON.stringify(checkHistory(store, originSet, options.localNodeName)) !== registry)
						throw new SubscriptionResumeError('transaction log membership changed during replay');
					const result = replayIterator.next();
					checkRange(replayRange);
					if (result.done) {
						if (pending.size) throw new SubscriptionResumeError('incomplete transaction');
						return result;
					}
					const entry = result.value;
					checkEntry(entry);
					const previous = pending.get(entry.logName);
					if (previous !== undefined && previous !== entry.txnLogKey)
						throw new SubscriptionResumeError('incomplete transaction');
					if (entry.endTxn) pending.delete(entry.logName);
					else pending.set(entry.logName, entry.txnLogKey);
					return result;
				} catch (error) {
					reader.return();
					throw error;
				}
			},
			return() {
				if (!closed) replayIterator.return?.();
				closed = true;
				return { done: true, value: undefined };
			},
		};
		iterator = undefined;
		return reader;
	} finally {
		scanning.delete(store.rootStore);
		iterator?.return?.();
	}
}
