import { info, trace } from '../utility/logging/harper_logger';
import { threadId } from 'worker_threads';
import { onMessageByType, broadcast, broadcastWithAcknowledgement } from '../server/threads/manageThreads';
import { writeKey } from 'ordered-binary';
import { IterableEventQueue } from './IterableEventQueue';
import { keyArrayToString } from './Resources';
import { readAuditEntry } from './auditStore';
const TRANSACTION_EVENT_TYPE = 'transaction';
const FAILED_CONDITION = 0x4000000;
let all_subscriptions;
const test = Buffer.alloc(4096);
/**
 * This module/function is responsible for the main work of tracking subscriptions and listening for new transactions
 * that have occurred on any thread, and then reading through the transaction log to notify listeners. This is
 * responsible for cleanup of subscriptions as well.
 * @param path
 * @param dbi
 * @param key
 * @param listener
 */
export function addSubscription(table, key, listener?: (key) => any, start_time: number) {
	const path = table.primaryStore.env.path;
	const table_id = table.primaryStore.tableId;
	// set up the subscriptions map. We want to just use a single map (per table) for efficient delegation
	// (rather than having every subscriber filter every transaction)
	if (!all_subscriptions) {
		onMessageByType(TRANSACTION_EVENT_TYPE, (event) => {
			notifyFromTransactionData(event.path);
		});
		all_subscriptions = Object.create(null); // using it as a map that doesn't change much
	}
	const database_subscriptions = all_subscriptions[path] || (all_subscriptions[path] = []);
	database_subscriptions.auditStore = table.auditStore;
	if (database_subscriptions.lastTxnTime == null) {
		database_subscriptions.lastTxnTime = Date.now();
	}
	let table_subscriptions = database_subscriptions[table_id];
	if (!table_subscriptions) {
		table_subscriptions = database_subscriptions[table_id] = new Map();
		table_subscriptions.envs = database_subscriptions;
		table_subscriptions.tableId = table_id;
		table_subscriptions.store = table.primaryStore;
	}

	key = keyArrayToString(key);
	const subscription = new Subscription(listener);
	subscription.startTime = start_time;
	let subscriptions: any[] = table_subscriptions.get(key);

	if (subscriptions) subscriptions.push(subscription);
	else {
		table_subscriptions.set(key, (subscriptions = [subscription]));
		subscriptions.tables = table_subscriptions;
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
	listener: (key) => any;
	subscriptions: [];
	startTime?: number;
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
			const table_subscriptions = this.subscriptions.tables;
			// TODO: Handle cleanup of wildcard
			const key = this.subscriptions.key;
			table_subscriptions.delete(key);
			if (table_subscriptions.size === 0) {
				const env_subscriptions = table_subscriptions.envs;
				const dbi = table_subscriptions.dbi;
				delete env_subscriptions[dbi];
			}
		}
		this.subscriptions = null;
	}
	toJSON() {
		return { name: 'subscription' };
	}
}

function notifyFromTransactionData(path, same_thread?) {
	if (!all_subscriptions) return;
	const subscriptions = all_subscriptions[path];
	if (!subscriptions) return; // if no subscriptions to this env path, don't need to read anything
	try {
		subscriptions.auditStore.resetReadTxn();
	} catch (error) {
		error.message += ' in ' + path;
		throw error;
	}
	let subscribers_with_txns;
	for (const { key: local_time, value: audit_entry_encoded } of subscriptions.auditStore.getRange({
		start: subscriptions.lastTxnTime,
		exclusiveStart: true,
	})) {
		subscriptions.lastTxnTime = local_time;
		const audit_entry = readAuditEntry(audit_entry_encoded);
		const table_subscriptions = subscriptions[audit_entry.tableId];
		if (!table_subscriptions) continue;
		const record_id = audit_entry.recordId;
		// TODO: How to handle invalidation
		let audit_record;
		let matching_key = keyArrayToString(audit_entry.recordId);
		let ancestor_level = 0;
		do {
			const key_subscriptions = table_subscriptions.get(matching_key);
			if (key_subscriptions) {
				for (const subscription of key_subscriptions) {
					if (
						ancestor_level > 0 && // only ancestors if the subscription is for ancestors (and apply onlyChildren filtering as necessary)
						!(subscription.includeDescendants && !(subscription.onlyChildren && ancestor_level > 1))
					)
						continue;
					if (subscription.startTime >= local_time) {
						info('omitting', record_id, subscription.startTime, local_time);
						continue;
					}
					try {
						if (subscription.crossThreads === false && !same_thread) continue;
						let begin_txn;
						if (subscription.supportsTransactions && subscription.txnInProgress !== audit_entry.version) {
							// if the subscriber supports transactions, we mark this as the beginning of a new transaction
							// tracking the subscription so that we can delimit the transaction on next transaction
							// (with a beginTxn flag, which may be on an end_txn event)
							begin_txn = true;
							if (!subscription.txnInProgress) {
								// if first txn for subscriber of this cycle, add to the transactional subscribers that we are tracking
								if (!subscribers_with_txns) subscribers_with_txns = [subscription];
								else subscribers_with_txns.push(subscription);
							}
							// the version defines the extent of a transaction, all audit records with the same version
							// are part of the same transaction, and when the version changes, we know it is a new
							// transaction
							subscription.txnInProgress = audit_entry.version;
						}
						subscription.listener(record_id, audit_entry, local_time, begin_txn);
					} catch (error) {
						console.error(error);
						info(error);
					}
				}
			}
			if (matching_key == null) break;
			const last_slash = matching_key.lastIndexOf?.('/', matching_key.length - 2);
			if (last_slash > -1) {
				matching_key = matching_key.slice(0, last_slash);
			} else matching_key = null;
			ancestor_level++;
		} while (true);
	}
	if (subscribers_with_txns) {
		// any subscribers with open transactions need to have an event to indicate that their transaction has been ended
		for (const subscription of subscribers_with_txns) {
			subscription.txnInProgress = null; // clean up
			subscription.listener(null, { type: 'end_txn' }, subscriptions.lastTxnTime, true);
		}
	}
}

/**
 * Interface with lmdb-js to listen for commits and find the SharedArrayBuffers that hold the transaction log/instructions.
 * @param primary_store
 */
export function listenToCommits(primary_store, audit_store) {
	const store = audit_store || primary_store;
	const lmdb_env = store.env;
	if (audit_store && !audit_store.cache) audit_store.cache = new Map(); // this is a trick to get the key and store information to pass through after the commit
	if (!lmdb_env.hasBroadcastListener) {
		lmdb_env.hasBroadcastListener = true;
		const path = lmdb_env.path;

		store.on('aftercommit', () => {
			// after each commit, broadcast the transaction to all threads so subscribers can read the
			// transactions and find changes of interest.
			broadcast({
				type: TRANSACTION_EVENT_TYPE,
				path,
			});
			// and notify on our own thread too
			notifyFromTransactionData(path, true);
		});
	}
}
