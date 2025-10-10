import { info, trace, warn } from '../utility/logging/harper_logger.js';
import { IterableEventQueue } from './IterableEventQueue.ts';
import { keyArrayToString } from './Resources.ts';
import { readAuditEntry } from './auditStore.ts';
import type { Id } from './ResourceInterface.ts';
const allSubscriptions = Object.create(null); // using it as a map that doesn't change much
const allSameThreadSubscriptions = Object.create(null); // using it as a map that doesn't change much
/**
 * This module/function is responsible for the main work of tracking subscriptions and listening for new transactions
 * that have occurred on any thread, and then reading through the transaction log to notify listeners. This is
 * responsible for cleanup of subscriptions as well.
 * @param path
 * @param dbi
 * @param key
 * @param listener
 */
export function addSubscription(table, key, listener?: (key) => any, startTime: number, options) {
	const path = table.primaryStore.env.path;
	const tableId = table.primaryStore.tableId;
	// set up the subscriptions map. We want to just use a single map (per table) for efficient delegation
	// (rather than having every subscriber filter every transaction)
	let baseSubscriptions;
	if (options?.crossThreads === false) {
		// we are only listening for commits on our own thread, so we use a separate subscriber and sequencer tracker
		baseSubscriptions = allSameThreadSubscriptions;
		listenToCommits(table.primaryStore, table.auditStore);
	} else {
		baseSubscriptions = allSubscriptions;
		if (!table.primaryStore.env.hasSubscriptionCommitListener) {
			table.primaryStore.env.hasSubscriptionCommitListener = true;
			table.primaryStore.on('committed', () => {
				notifyFromTransactionData(allSubscriptions[path]);
			});
		}
	}
	const databaseSubscriptions = baseSubscriptions[path] || (baseSubscriptions[path] = []);
	databaseSubscriptions.auditStore = table.auditStore;
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
	let subscriptions: any[] = tableSubscriptions.get(key);

	if (subscriptions) subscriptions.push(subscription);
	else {
		tableSubscriptions.set(key, (subscriptions = [subscription]));
		subscriptions.tables = tableSubscriptions;
		subscriptions.key = key;
	}
	subscription.subscriptions = subscriptions;
	return subscription;
}

/**
 * This is the class that is returned from subscribe calls and provide the interface to set a callback, end the
 * subscription and get the initial state.
 */
class Subscription extends IterableEventQueue {
	listener: (recordId: Id, auditEntry: any, localTime: number, beginTxn: boolean) => void;
	subscriptions: [];
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
		// cleanup
		if (!this.subscriptions) return;
		this.subscriptions.splice(this.subscriptions.indexOf(this), 1);
		if (this.subscriptions.length === 0) {
			const tableSubscriptions = this.subscriptions.tables;
			if (tableSubscriptions) {
				// TODO: Handle cleanup of wildcard
				const key = this.subscriptions.key;
				tableSubscriptions.delete(key);
				if (tableSubscriptions.size === 0) {
					const envSubscriptions = tableSubscriptions.envs;
					const dbi = tableSubscriptions.dbi;
					delete envSubscriptions[dbi];
				}
			}
		}
		this.subscriptions = null;
	}
	toJSON() {
		return { name: 'subscription' };
	}
}
function notifyFromTransactionData(subscriptions) {
	if (!subscriptions) return; // if no subscriptions to this env path, don't need to read anything
	const auditStore = subscriptions.auditStore;
	auditStore.resetReadTxn();
	nextTransaction(subscriptions.auditStore);
	let subscribersWithTxns;
	for (const { key: localTime, value: auditEntryEncoded } of auditStore.getRange({
		start: subscriptions.lastTxnTime,
		exclusiveStart: true,
	})) {
		subscriptions.lastTxnTime = localTime;
		const auditEntry = readAuditEntry(auditEntryEncoded);
		const tableSubscriptions = subscriptions[auditEntry.tableId];
		if (!tableSubscriptions) continue;
		const recordId = auditEntry.recordId;
		// TODO: How to handle invalidation
		let matchingKey = keyArrayToString(recordId);
		let ancestorLevel = 0;
		do {
			// we iterate through the key hierarchy, notifying all subscribers for each key,
			// so for an id like resource/foo/bar, we notify subscribers for resource/foo/bar, resource/foo/, resource/foo, resource/, and resource
			// this allows for efficient subscriptions to children ids/topics
			const keySubscriptions = tableSubscriptions.get(matchingKey);
			if (keySubscriptions) {
				for (const subscription of keySubscriptions) {
					if (
						ancestorLevel > 0 && // only ancestors if the subscription is for ancestors (and apply onlyChildren filtering as necessary)
						!(subscription.includeDescendants && !(subscription.onlyChildren && ancestorLevel > 1))
					)
						continue;
					if (subscription.startTime >= localTime) {
						info('omitting', recordId, subscription.startTime, localTime);
						continue;
					}
					try {
						let beginTxn;
						if (subscription.supportsTransactions && subscription.txnInProgress !== auditEntry.version) {
							// if the subscriber supports transactions, we mark this as the beginning of a new transaction
							// tracking the subscription so that we can delimit the transaction on next transaction
							// (with a beginTxn flag, which may be on an endTxn event)
							beginTxn = true;
							if (!subscription.txnInProgress) {
								// if first txn for subscriber of this cycle, add to the transactional subscribers that we are tracking
								if (!subscribersWithTxns) subscribersWithTxns = [subscription];
								else subscribersWithTxns.push(subscription);
							}
							// the version defines the extent of a transaction, all audit records with the same version
							// are part of the same transaction, and when the version changes, we know it is a new
							// transaction
							subscription.txnInProgress = auditEntry.version;
						}
						subscription.listener(recordId, auditEntry, localTime, beginTxn);
					} catch (error) {
						console.error(error);
						info(error);
					}
				}
			}
			if (matchingKey == null) break;
			const lastSlash = matchingKey.lastIndexOf?.('/', matchingKey.length - 2);
			if (lastSlash !== matchingKey.length - 1) {
				ancestorLevel++; // don't increase the ancestor level for this going from resource/ to resource
			}
			if (lastSlash > -1) {
				matchingKey = matchingKey.slice(0, lastSlash + 1);
			} else matchingKey = null;
		} while (true);
	}
	if (subscribersWithTxns) {
		// any subscribers with open transactions need to have an event to indicate that their transaction has been ended
		for (const subscription of subscribersWithTxns) {
			subscription.txnInProgress = null; // clean up
			subscription.listener(null, { type: 'end_txn' }, subscriptions.lastTxnTime, true);
		}
	}
}
/**
 * Interface with lmdb-js to listen for commits and traverse the audit log.
 * @param primaryStore
 */
export function listenToCommits(primaryStore, auditStore) {
	const store = auditStore || primaryStore;
	const lmdbEnv = store.env;
	if (!lmdbEnv.hasAfterCommitListener) {
		lmdbEnv.hasAfterCommitListener = true;
		const path = lmdbEnv.path;
		store.on('aftercommit', ({ next, last, txnId }) => {
			const subscriptions = allSameThreadSubscriptions[path]; // there is a different set of subscribers for same-thread subscriptions
			if (!subscriptions) return;
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
			if (!store.attemptLock('thread-local-writes', acquiredLock)) return;
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
