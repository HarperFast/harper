import { basename } from 'node:path';
import { warn } from '../utility/logging/harper_logger.js';
import { DatabaseClosingError, DatabaseGenerationChangedError } from '../utility/errors/hdbError.ts';
import { IterableEventQueue } from './IterableEventQueue.ts';
import { keyArrayToString } from './Resources.ts';
import type { Id } from './ResourceInterface.ts';

const allSubscriptions = Object.create(null); // using it as a map that doesn't change much
const allSameThreadSubscriptions = Object.create(null); // using it as a map that doesn't change much
// The handle each database path was last opened with on this thread, kept as a token so a retired database's closed
// store graph is not retained. A registration through any other handle would join the entry the current store's
// commits drive while reading through that handle's closed stores.
const HANDLE_TOKEN = Symbol('subscription-handle');
const currentHandles = new Map<
	string,
	{ token: symbol; generationId: string | undefined; tracksGeneration: boolean }
>();

// A store with no generation (LMDB) is never replaced by a copy, so its reopen is only ever a close.
function generationChanged(
	generationId: string | null | undefined,
	currentId: string | null | undefined,
	tracksGeneration: boolean
): boolean {
	return tracksGeneration && !(generationId != null && generationId === currentId);
}

function closingError(auditStore: any, path: string): DatabaseClosingError {
	return new DatabaseClosingError(auditStore?.rootStore?.databaseName ?? basename(path));
}
/**
 * This module/function is responsible for the main work of tracking subscriptions and listening for new transactions
 * that have occurred on any thread, and then reading through the transaction log to notify listeners. This is
 * responsible for cleanup of subscriptions as well.
 * @param table
 * @param key
 * @param listener
 * @param startTime
 * @param options
 */
export function addSubscription(table, key, listener?: (key) => any, startTime?: number, options?: any) {
	const path = table.primaryStore.path;
	const tableId = table.primaryStore.tableId;
	// set up the subscriptions map. We want to just use a single map (per table) for efficient delegation
	// (rather than having every subscriber filter every transaction)
	let databaseSubscriptions;
	if (!path) {
		throw new Error('No path for table primary store');
	}
	const generationId = table.auditStore?.databaseGeneration?.id ?? null;
	const current = currentHandles.get(path);
	const replaced = current !== undefined && table.auditStore?.[HANDLE_TOKEN] !== current.token;
	if (replaced || table.auditStore?.rootStore?.status === 'closed') {
		if (options?.scope === 'full-database') return;
		throw replaced && generationChanged(generationId, current.generationId, current.tracksGeneration)
			? new DatabaseGenerationChangedError()
			: closingError(table.auditStore, path);
	}
	if (options?.crossThreads === false) {
		// we are only listening for commits on our own thread, so we use a separate subscriber and sequencer tracker
		databaseSubscriptions = allSameThreadSubscriptions[path] || (allSameThreadSubscriptions[path] = []);
		listenToCommits(table.primaryStore, table.auditStore);
	} else {
		databaseSubscriptions = allSubscriptions[path] || (allSubscriptions[path] = []);
		const auditStore = table.auditStore;
		if (!auditStore.hasSubscriptionCommitListener) {
			let auditLogIterator;
			if (auditStore.reusableIterable) {
				// with rocksdb-js iterator we can and should not specify a start time so we just start at the end of the txn log
				// and still match older version numbers that may commit in the future. But we have to start
				// immediately so we are at the right position
				auditLogIterator = auditStore.getRange({});
			}
			auditStore.hasSubscriptionCommitListener = true;
			// Coalesce 'committed' bursts: instead of iterating the audit log synchronously inside the
			// commit microtask (which pegs the event loop during replication backlog catch-up), defer
			// to setImmediate. Multiple commits within the same turn collapse into one notify pass.
			// notifyScheduled stays true for the full drain — including yield-and-resume — so new
			// 'committed' events that fire mid-drain don't spawn an overlapping notify pass.
			auditStore.on('committed', () => {
				if (!databaseSubscriptions.activeCount) {
					// No per-key listeners; skip the expensive audit-log iteration entirely. But still
					// rotate the nextTransaction promise so any whenNextTransaction() waiter (used by
					// outbound replication on databases with no local subscribers) wakes up.
					if (auditStore.nextTransaction) nextTransaction(auditStore);
					return;
				}
				if (databaseSubscriptions.notifyScheduled) return;
				databaseSubscriptions.notifyScheduled = true;
				setImmediate(() => notifyFromTransactionData(databaseSubscriptions, auditLogIterator, true));
			});
		}
	}
	databaseSubscriptions.auditStore = table.auditStore;
	databaseSubscriptions.generationId ??= generationId;
	if (databaseSubscriptions.lastTxnTime == null) {
		databaseSubscriptions.lastTxnTime = Date.now();
	}
	if (options?.scope === 'full-database') {
		return;
	}
	let tableSubscriptions = databaseSubscriptions[tableId];
	if (!tableSubscriptions) {
		tableSubscriptions = databaseSubscriptions[tableId] = new Map();
		tableSubscriptions.envs = databaseSubscriptions;
		tableSubscriptions.tableId = tableId;
		tableSubscriptions.store = table.primaryStore;
	}

	key = keyArrayToString(key);
	const subscription = new Subscription(listener);
	subscription.startTime = startTime;
	let subscriptions: any = tableSubscriptions.get(key);

	if (subscriptions) subscriptions.push(subscription);
	else {
		tableSubscriptions.set(key, (subscriptions = [subscription]));
		subscriptions.tables = tableSubscriptions;
		subscriptions.key = key;
		subscriptions.traversals = 0;
		subscriptions.hasEnded = false;
	}
	subscription.subscriptions = subscriptions;
	databaseSubscriptions.activeCount = (databaseSubscriptions.activeCount || 0) + 1;
	return subscription;
}

/**
 * End every subscription this thread registered on the database before `auditStore` reopened it: its commit
 * listener and its table's stores belong to the closed handle, so it can never deliver again. On a store that
 * tracks generations, another or an unknown one must resynchronize; otherwise the retryable
 * `DatabaseClosingError`. `auditStore` becomes the only handle `addSubscription` accepts on the path before
 * any listener runs.
 */
export function endSubscriptionsFromEarlierHandles(auditStore: any, tracksGeneration: boolean): void {
	const path = auditStore.rootStore.path;
	const generationId = auditStore.databaseGeneration?.id;
	const token = Symbol(basename(path));
	auditStore[HANDLE_TOKEN] = token;
	currentHandles.set(path, { token, generationId, tracksGeneration });
	for (const registry of [allSubscriptions, allSameThreadSubscriptions]) {
		const databaseSubscriptions = registry[path];
		if (!databaseSubscriptions) continue;
		delete registry[path];
		const changed = generationChanged(databaseSubscriptions.generationId, generationId, tracksGeneration);
		for (const tableId in databaseSubscriptions) {
			const tableSubscriptions = databaseSubscriptions[tableId];
			if (!(tableSubscriptions instanceof Map)) continue;
			for (const keySubscriptions of tableSubscriptions.values()) {
				for (const subscription of [...keySubscriptions]) {
					try {
						subscription.close(changed ? new DatabaseGenerationChangedError() : closingError(auditStore, path));
					} catch (error) {
						try {
							warn(error);
						} catch {}
					} finally {
						// a listener that threw on the final event left the queue open; a bare close sends nothing
						if (!subscription.closed) {
							try {
								subscription.close();
							} catch {}
						}
					}
				}
			}
		}
	}
}

/**
 * This is the class that is returned from subscribe calls and provide the interface to set a callback, end the
 * subscription and get the initial state.
 */
class Subscription extends IterableEventQueue {
	listener: (recordId: Id, auditEntry: any, txnLogKey: number, beginTxn: boolean) => void;
	subscriptions: any;
	startTime?: number;
	includeDescendants?: boolean;
	supportsTransactions?: boolean;
	onlyChildren?: boolean;
	constructor(listener) {
		super();
		this.listener = listener;
		this.on('close', () => this.end());
	}
	end() {
		const subscriptions = this.subscriptions;
		if (subscriptions) {
			this.subscriptions = null;
			const envSubscriptions = subscriptions.tables?.envs;
			if (envSubscriptions?.activeCount > 0) envSubscriptions.activeCount--;
			// splicing would shift the next subscriber past a loop walking this array, which compacts it when it finishes
			if (subscriptions.traversals > 0) subscriptions.hasEnded = true;
			else {
				const index = subscriptions.indexOf(this);
				if (index > -1) subscriptions.splice(index, 1);
				if (subscriptions.length === 0) detachKeySubscriptions(subscriptions);
			}
		}
		this.close();
	}
	toJSON() {
		return { name: 'subscription' };
	}
}
function endTraversal(keySubscriptions) {
	if (--keySubscriptions.traversals === 0 && keySubscriptions.hasEnded) {
		keySubscriptions.hasEnded = false;
		let kept = 0;
		for (let i = 0; i < keySubscriptions.length; i++) {
			const subscription = keySubscriptions[i];
			if (subscription.subscriptions) keySubscriptions[kept++] = subscription;
		}
		keySubscriptions.length = kept;
		if (kept === 0) detachKeySubscriptions(keySubscriptions);
	}
}
function detachKeySubscriptions(keySubscriptions) {
	const tableSubscriptions = keySubscriptions.tables;
	if (tableSubscriptions) {
		// TODO: Handle cleanup of wildcard
		tableSubscriptions.delete(keySubscriptions.key);
		if (tableSubscriptions.size === 0) delete tableSubscriptions.envs[tableSubscriptions.tableId];
	}
}
const ACTIONS_OF_INTEREST = ['put', 'patch', 'delete', 'message', 'invalidate'];
// Maximum audit records processed per synchronous turn before yielding back to the event loop.
// Sized to keep per-batch wall time within a few ms on commodity hardware while keeping the
// scheduling overhead amortized; tune if profiling shows different shapes.
const NOTIFY_BATCH_SIZE = 256;
function notifyFromTransactionData(subscriptions, auditLogIterable?, allowYield = false) {
	if (!subscriptions) return; // if no subscriptions to this env path, don't need to read anything
	// If no real subscribers are attached, skip the iteration. The reusable iterator preserves its
	// position and will pick up from where we left it once a subscriber is added.
	if (!subscriptions.activeCount) {
		subscriptions.pendingTxnSubscribers = null; // discard any carry-over from a yielded run
		if (allowYield) subscriptions.notifyScheduled = false;
		return;
	}
	const auditStore = subscriptions.auditStore;
	auditStore.resetReadTxn?.();
	nextTransaction(auditStore);
	// subscribersWithTxns is carried across batches so the end_txn signal fires only once the
	// iterator truly drains, not at each yield point.
	let subscribersWithTxns = subscriptions.pendingTxnSubscribers;
	if (!auditLogIterable) {
		// rocksdb will pass this in, but with lmdb, we have to re-create the iterable
		auditLogIterable = auditStore.getRange({
			start: subscriptions.lastTxnTime,
			exclusiveStart: true,
		});
	}
	const iterator = auditLogIterable[Symbol.iterator]?.() ?? auditLogIterable;
	let processed = 0;
	let yielded = false;
	try {
		while (true) {
			let result;
			try {
				result = iterator.next();
			} catch (error) {
				// We run from setImmediate, so an iterator throw here becomes an
				// uncaughtException that kills the worker (RocksTransactionLogStore's
				// own safeNext should already prevent this for the corrupt-entry case,
				// but defense in depth — a stale crash here permanently silences this
				// subscription set on every commit). Stop draining this pass; the next
				// commit reschedules another notify cycle.
				warn('Audit log iterator failed during broadcast; stopping this pass', error);
				break;
			}
			if (result.done) break;
			const auditRecord = result.value;
			const timestamp: number = auditRecord.txnLogKey;
			subscriptions.lastTxnTime = timestamp;
			// the transaction extent: RocksDB entries committed together share the log key (record
			// versions may differ); LMDB's transaction-log key is per-entry, so version delimits there
			const txnKey = auditStore.reusableIterable ? timestamp : auditRecord.version;
			if (ACTIONS_OF_INTEREST.includes(auditRecord.type)) {
				const tableSubscriptions = subscriptions[auditRecord.tableId];
				if (tableSubscriptions) {
					const recordId = auditRecord.recordId;
					// TODO: How to handle invalidation
					let matchingKey = keyArrayToString(recordId);
					let ancestorLevel = 0;
					do {
						// we iterate through the key hierarchy, notifying all subscribers for each key,
						// so for an id like resource/foo/bar, we notify subscribers for resource/foo/bar, resource/foo/, resource/, and the root (null)
						// this allows for efficient subscriptions to children ids/topics
						const keySubscriptions = tableSubscriptions.get(matchingKey);
						if (keySubscriptions) {
							keySubscriptions.traversals++;
							try {
								// a subscriber added during this walk starts with the next record
								for (let i = 0, length = keySubscriptions.length; i < length; i++) {
									const subscription = keySubscriptions[i];
									if (!subscription.subscriptions) continue;
									if (
										ancestorLevel > 0 && // only ancestors if the subscription is for ancestors (and apply onlyChildren filtering as necessary)
										!(subscription.includeDescendants && !(subscription.onlyChildren && ancestorLevel > 1))
									)
										continue;
									if (subscription.startTime >= timestamp) {
										continue;
									}
									try {
										let beginTxn;
										if (subscription.supportsTransactions && subscription.txnInProgress !== txnKey) {
											// if the subscriber supports transactions, we mark this as the beginning of a new transaction
											// tracking the subscription so that we can delimit the transaction on next transaction
											// (with a beginTxn flag, which may be on an endTxn event)
											beginTxn = true;
											if (!subscription.txnInProgress) {
												// if first txn for subscriber of this cycle, add to the transactional subscribers that we are tracking
												if (!subscribersWithTxns) subscribersWithTxns = [subscription];
												else subscribersWithTxns.push(subscription);
											}
											subscription.txnInProgress = txnKey;
										}
										subscription.listener(recordId, auditRecord, timestamp, beginTxn);
									} catch (error) {
										warn(error);
									}
								}
							} finally {
								endTraversal(keySubscriptions);
							}
						}
						if (matchingKey == null) break;
						const lastSlash = matchingKey.lastIndexOf?.('/', matchingKey.length - 2);
						if (lastSlash !== matchingKey.length - 1) {
							ancestorLevel++; // don't increase the ancestor level for this going from resource/ to resource
						}
						// lastIndexOf clamps a negative fromIndex to 0, so '/' would otherwise yield itself forever
						const parentKey = lastSlash > -1 ? matchingKey.slice(0, lastSlash + 1) : null;
						matchingKey = parentKey === matchingKey ? null : parentKey;
					} while (true);
				}
			} else if (auditRecord.type === 'reload') {
				// Whole-table reload marker (harper-pro#489): a copyApply base copy back-filled this table's
				// rows as snapshots with no per-row audit entries, so deliver one signal to EVERY subscriber on
				// the table (regardless of key — there is no recordId to walk the key hierarchy) so each re-reads
				// the bulk-reloaded table. hdb_nodes peer discovery and hdb_certificate CA install rely on this.
				const tableSubscriptions = subscriptions[auditRecord.tableId];
				if (tableSubscriptions) {
					// keys added during the walk are appended, so this cap keeps listeners from extending it
					let remainingKeys = tableSubscriptions.size;
					for (const keySubscriptions of tableSubscriptions.values()) {
						if (remainingKeys-- === 0) break;
						keySubscriptions.traversals++;
						try {
							for (let i = 0, length = keySubscriptions.length; i < length; i++) {
								const subscription = keySubscriptions[i];
								if (!subscription.subscriptions || subscription.startTime >= timestamp) continue;
								try {
									subscription.listener(null, auditRecord, timestamp, false);
								} catch (error) {
									warn(error);
								}
							}
						} finally {
							endTraversal(keySubscriptions);
						}
					}
				}
			}
			if (allowYield && ++processed >= NOTIFY_BATCH_SIZE) {
				// Yield the event loop. Save in-progress txn state so the next batch can resume.
				// Reusable iterables (rocksdb) can be passed back in directly; LMDB-style iterables
				// are recreated from the advanced lastTxnTime. The same-thread aftercommit path does not
				// set allowYield because it holds an inter-thread lock that must not span event-loop turns.
				subscriptions.pendingTxnSubscribers = subscribersWithTxns;
				yielded = true;
				setImmediate(() =>
					notifyFromTransactionData(subscriptions, auditStore.reusableIterable ? auditLogIterable : null, true)
				);
				return;
			}
		}
		subscriptions.pendingTxnSubscribers = null;
		if (subscribersWithTxns) {
			// any subscribers with open transactions need to have an event to indicate that their transaction has been ended
			for (const subscription of subscribersWithTxns) {
				subscription.txnInProgress = null; // clean up
				if (!subscription.subscriptions) continue;
				try {
					subscription.listener(null, { type: 'end_txn' }, subscriptions.lastTxnTime, true);
				} catch (error) {
					warn(error);
				}
			}
		}
	} finally {
		// If we yielded, the continuation owns notifyScheduled; otherwise (drain or any throw) we
		// must clear it here so a stuck flag doesn't permanently silence future commits.
		if (allowYield && !yielded) subscriptions.notifyScheduled = false;
	}
}
/**
 * Interface with database to listen for commits and traverse the audit log only on the same thread.
 * @param primaryStore
 * @param auditStore
 */
export function listenToCommits(primaryStore, auditStore) {
	const store = auditStore || primaryStore;
	const path = primaryStore.path;
	const lmdbEnv = store.env;
	if (!lmdbEnv.hasAfterCommitListener) {
		lmdbEnv.hasAfterCommitListener = true;
		store.on('aftercommit', (logEntries) => {
			const subscriptions = allSameThreadSubscriptions[path]; // there is a different set of subscribers for same-thread subscriptions
			if (!subscriptions) return;
			// With RocksTransactionLog, we actually have direct access to the list of log entries:
			if (Array.isArray(logEntries)) {
				return notifyFromTransactionData(subscriptions, logEntries);
			}
			// we want each thread to do this mutually exclusively so that we don't have multiple threads trying to process the same data (the intended purpose of crossThreads=false)
			const acquiredLock = () => {
				// we have the lock, so we can now read the last sequence/local write time and continue to read the audit log from there
				if (!store.threadLocalWrites)
					// initiate the shared buffer if needed
					store.threadLocalWrites = new Float64Array(
						store.getUserSharedBuffer('last-thread-local-write', new ArrayBuffer(8))
					);
				subscriptions.txnTime = store.threadLocalWrites[0] || Date.now(); // start from last one
				try {
					notifyFromTransactionData(subscriptions);
				} finally {
					store.threadLocalWrites[0] = subscriptions.lastTxnTime; // update shared buffer
					store.unlock('thread-local-writes'); // and release the lock
				}
			};
			// try to get lock or wait for it
			if (!store.tryLock('thread-local-writes', acquiredLock)) return;
			acquiredLock();
		});
	}
}
function nextTransaction(auditStore) {
	auditStore.nextTransaction?.resolve();
	let nextResolve;
	auditStore.nextTransaction = new Promise((resolve) => {
		nextResolve = resolve;
	});
	auditStore.nextTransaction.resolve = nextResolve;
}

export function whenNextTransaction(auditStore) {
	if (!auditStore.nextTransaction) {
		addSubscription(
			{
				primaryStore: auditStore,
				auditStore,
			},
			null,
			null,
			0,
			{ scope: 'full-database' }
		);
		nextTransaction(auditStore);
	}
	return auditStore.nextTransaction;
}
