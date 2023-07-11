import { readKey } from 'ordered-binary';
import { info } from '../utility/logging/harper_logger';
import { threadId } from 'worker_threads';
import { onMessageFromWorkers, broadcast } from '../server/threads/manageThreads';
import { MAXIMUM_KEY } from 'ordered-binary';
import { tables } from './databases';
import { getLastTxnId } from 'lmdb';
import { writeKey } from 'ordered-binary';
import { IterableEventQueue } from './IterableEventQueue';
import { keyArrayToString } from './Resources';
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
export function addSubscription(table, key, listener?: (key) => any, start_time: number, include_descendants) {
	const path = table.primaryStore.env.path;
	const table_id = table.primaryStore.tableId;
	// set up the subscriptions map. We want to just use a single map (per table) for efficient delegation
	// (rather than having every subscriber filter every transaction)
	if (!all_subscriptions) {
		onMessageFromWorkers((event) => {
			if (event.type === TRANSACTION_EVENT_TYPE) {
				/* TODO: We want to actually pass around the LMDB txn id and the first time stamp, as it should be much more
				     efficient, but first we
				need lmdb-js support for get the txn_id cursor/range entries, so we can validate each entry matches
				the txn_id
				const txn_id = event.txnId;
				const first_txn = event.firstTxn;
				 */
				const audit_ids = event.auditIds;
				notifyFromTransactionData(event.path, audit_ids);
			}
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

let last_time = Date.now();
function notifyFromTransactionData(path, audit_ids, same_thread?) {
	if (!all_subscriptions) return;
	const subscriptions = all_subscriptions[path];
	if (!subscriptions) return; // if no subscriptions to this env path, don't need to read anything
	/*
	TODO: Once we have lmdb-js support for returning lmdb txn ids, we can iterate with checks on the txn id.
	 for (const { key, value: audit_record } of subscriptions.auditStore.getRange({ start: [first_txn, MAXIMUM_KEY] })) {
		if (txn_id !== getLastTxnId()) continue;

	 */
	subscriptions.auditStore.resetReadTxn();
	for (const audit_id of audit_ids) {
		const [txn_time, table_id, record_key] = audit_id;
		last_time = txn_time;
		const table_subscriptions = subscriptions[table_id];
		if (!table_subscriptions) continue;
		writeKey(audit_id, test, 0);
		const audit_record = subscriptions.auditStore.get(audit_id);
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
export function listenToCommits(audit_store) {
	const lmdb_env = audit_store.env;
	audit_store.cache = new Map(); // this is a trick to get the key and store information to pass through after the commit
	if (!lmdb_env.hasBroadcastListener) {
		lmdb_env.hasBroadcastListener = true;
		const path = lmdb_env.path;

		audit_store.on('aftercommit', ({ next, last, txnId }) => {
			// after each commit, broadcast the transaction to all threads so subscribers can read the
			// transactions and find changes of interest. We try to use the same binary format for
			// transactions that is used by lmdb-js for minimal modification and since the binary
			// format can readily be shared with other threads
			const transaction_buffers = [];
			let last_uint32;
			let start;
			let first_txn;
			const audit_ids = [];
			// get all the buffers (and starting position of the first) in this transaction
			do {
				/* TODO: Once we have lmdb support for return txn ids, we can just get the first one
				if (!first_txn && next.meta && next.meta.store === audit_store && next.meta.key) {
					first_txn = next.meta.key[0];
					break;
				}*/
				if (next.flag & FAILED_CONDITION) continue;
				let key;
				if (next.meta && next.meta.store === audit_store && (key = next.meta.key)) {
					if (typeof key[2] === 'symbol') key[2] = null;
					audit_ids.push(key);
				}
				if (next.uint32 !== last_uint32) {
					last_uint32 = next.uint32;
					if (last_uint32) {
						if (start === undefined) start = next.flagPosition;
						transaction_buffers.push(last_uint32.buffer);
					}
				}
			} while (next != last && (next = next.next));
			// broadcast all the transaction buffers so they can be (sequentially) read and subscriptions messages
			// delivered on all other threads
			//if (first_txn) {
			broadcast({
				type: TRANSACTION_EVENT_TYPE,
				path,
				buffers: transaction_buffers,
				auditIds: audit_ids,
				//txnId,
				//firstTxn: first_txn,
				start,
			});
			// and notify on our own thread too
			notifyFromTransactionData(path, audit_ids, true);
			//}
		});
	}
}
