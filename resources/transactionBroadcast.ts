import { info, trace } from '../utility/logging/harper_logger';
import { threadId } from 'worker_threads';
import { onMessageByType, broadcast, broadcastWithAcknowledgement } from '../server/threads/manageThreads';
import { writeKey } from 'ordered-binary';
import { IterableEventQueue } from './IterableEventQueue';
import { keyArrayToString } from './Resources';
import { readAuditEntry } from './auditStore';
const TRANSACTION_EVENT_TYPE = 'transaction';
const TRANSACTION_AWAIT_EVENT_TYPE = 'transaction-await';
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
export function addSubscription(table, key, listener?: (key) => any, start_time: number, include_descendants) {
	const path = table.primaryStore.env.path;
	const table_id = table.primaryStore.tableId;
	// set up the subscriptions map. We want to just use a single map (per table) for efficient delegation
	// (rather than having every subscriber filter every transaction)
	if (!all_subscriptions) {
		onMessageByType(TRANSACTION_EVENT_TYPE, (event) => {
			const audit_ids = event.auditIds;
			notifyFromTransactionData(event.path, audit_ids, event.txnId);
		});
		onMessageByType(TRANSACTION_AWAIT_EVENT_TYPE, (event) => {
			trace('confirming to proceed with txn', event.txnId);
		});
		all_subscriptions = Object.create(null); // using it as a map that doesn't change much
	}
	const database_subscriptions = all_subscriptions[path] || (all_subscriptions[path] = []);
	database_subscriptions.auditStore = table.auditStore;
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
	if (include_descendants) subscription.includeDescendants = include_descendants;
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
	}
	end() {
		// cleanup
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
	}
	toJSON() {
		return { name: 'subscription' };
	}
}

let last_txn_id;
const delayed_notifications = new Map();
function notifyFromTransactionData(path, audit_ids, txn_id, same_thread?) {
	if (!all_subscriptions) return;
	const subscriptions = all_subscriptions[path];
	if (!subscriptions) return; // if no subscriptions to this env path, don't need to read anything
	if (last_txn_id && last_txn_id + 1 !== txn_id) {
		// if the transactions are not in order, we broadcast to ensure that we have
		// awaited any other threads that have out of order transactions to broadcast
		// TODO: we don't actually have a listener for this, and generally this back
		// and forth should usually be sufficient to get the other threads to broadcast
		// their txns, but we should probably add a listener to verify
		trace('Waiting to ensure latest txn id', last_txn_id, 'proceeds', txn_id, same_thread);
		const completion = (async () => {
			// wait for any other delayed notifications with earlier txn ids first
			for (const [other_txn_id, completion] of delayed_notifications) {
				if (other_txn_id < txn_id) {
					trace('Txn', txn_id, 'waiting for txn', other_txn_id);
					await completion;
				}
			}
			if (last_txn_id + 1 !== txn_id) {
				// if we still need to wait, send out request
				await broadcastWithAcknowledgement({
					type: TRANSACTION_AWAIT_EVENT_TYPE,
					txnId: txn_id,
				});
				// wait for any other delayed notifications with earlier txn ids that were added
				for (const [other_txn_id, completion] of delayed_notifications) {
					if (other_txn_id < txn_id) {
						trace('Txn', txn_id, 'waiting for txn', other_txn_id);
						await completion;
					}
				}
			}
			delayed_notifications.delete(txn_id);
			trace('Proceeding with txn id', txn_id);
			last_txn_id = txn_id - 1; // give it the green light to proceed
			notifyFromTransactionData(path, audit_ids, txn_id, same_thread);
		})();
		delayed_notifications.set(txn_id, completion);
		return completion;
	}
	trace('Notifying with txn id', txn_id, same_thread);
	last_txn_id = txn_id;
	try {
		subscriptions.auditStore.resetReadTxn();
	} catch (error) {
		error.message += ' in ' + path;
		throw error;
	}
	audit_id_loop: for (const audit_id of audit_ids) {
		const [txn_time, table_id, record_key] = audit_id;
		const table_subscriptions = subscriptions[table_id];
		if (!table_subscriptions) continue;
		writeKey(audit_id, test, 0);
		const is_invalidation = audit_id[3];
		if (is_invalidation) audit_id.length = 3;
		let audit_record;
		let matching_key = keyArrayToString(record_key);
		let is_ancestor;
		do {
			const key_subscriptions = table_subscriptions.get(matching_key);
			if (key_subscriptions) {
				for (const subscription of key_subscriptions) {
					if (is_ancestor && !subscription.includeDescendants) continue;
					if (subscription.startTime >= txn_time) {
						info('omitting', record_key, subscription.startTime, txn_time);
						continue;
					}
					try {
						if (subscription.crossThreads === false && !same_thread) continue;
						if (audit_record === undefined) {
							const audit_record_encoded = subscriptions.auditStore.get(audit_id);
							if (!audit_record_encoded) continue audit_id_loop; // if the audit record is pruned before we get to it, this can be undefined/null
							audit_record = readAuditEntry(audit_record_encoded, table_subscriptions.store);
							if (
								audit_record.operation !== 'message' &&
								// check to see if the latest is out-of-date, and if it is we skip it, except for messages were we try not to drop any
								table_subscriptions.store.getEntry(audit_id[2])?.version !== audit_id[0]
							)
								continue audit_id_loop;

							if (is_invalidation && audit_record.operation !== 'invalidate') continue audit_id_loop; // this indicates that the invalidation entry has already been replaced, so just wait for the second update
						}
						subscription.listener(record_key, audit_record, txn_time);
					} catch (error) {
						console.error(error);
						info(error);
					}
				}
			}
			if (matching_key == null) break;
			const last_slash = matching_key.lastIndexOf?.('/', matching_key.length - 2);
			if (last_slash > -1) {
				matching_key = matching_key.slice(0, last_slash + 1);
			} else matching_key = null;
			is_ancestor = true;
		} while (true);
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

		store.on('aftercommit', ({ next, last, txnId }) => {
			// after each commit, broadcast the transaction to all threads so subscribers can read the
			// transactions and find changes of interest. We try to use the same binary format for
			// transactions that is used by lmdb-js for minimal modification and since the binary
			// format can readily be shared with other threads
			let start;
			const audit_ids = [];
			if (audit_store) {
				// get all the buffers (and starting position of the first) in this transaction
				do {
					if (next.flag & FAILED_CONDITION) continue;
					let key;
					if (next.meta && next.meta.store === audit_store && (key = next.meta.key)) {
						if (typeof key[2] === 'symbol') key[2] = null;
						if (key.invalidated) key[3] = true; // how we indicate invalidation for now
						audit_ids.push(key);
					}
				} while (next != last && (next = next.next));
			}
			if (audit_ids.length === 0) return;
			// broadcast all the transaction buffers so they can be (sequentially) read and subscriptions messages
			// delivered on all other threads
			broadcast({
				type: TRANSACTION_EVENT_TYPE,
				path,
				auditIds: audit_ids,
				txnId,
				start,
			});
			// and notify on our own thread too
			notifyFromTransactionData(path, audit_ids, txnId, true);
		});
	}
}
