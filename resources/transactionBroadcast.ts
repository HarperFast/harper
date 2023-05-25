import { readKey } from 'ordered-binary';
import { info } from '../utility/logging/harper_logger';
import { threadId } from 'worker_threads';
import { onMessageFromWorkers, broadcast } from '../server/threads/manageThreads';
import { MAXIMUM_KEY } from 'ordered-binary';
import { tables } from './databases';
import { getLastTxnId } from 'lmdb';
import { writeKey } from 'ordered-binary';
import { IterableEventQueue } from './IterableEventQueue';
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
				notifyFromTransactionData(path, audit_ids);
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
		table_subscriptions.allKeys = [];
	}
	const subscription = new Subscription(listener);
	subscription.startTime = start_time;
	if (key == null) {
		table_subscriptions.allKeys.push(subscription);
		subscription.subscriptions = table_subscriptions.allKeys;
		subscription.subscriptions.tables = table_subscriptions;
		return subscription;
	}
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
			if (key !== undefined)
				// otherwise it is allKeys
				table_subscriptions.delete(key);
			if (table_subscriptions.size === 0 && table_subscriptions.allKeys.length === 0) {
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

/**
 * This does the low level work of scanning the lmdb-js transaction log, in its binary format. This is usually written
 * by other threads, and shared with us through a SharedArrayBuffer (extremely efficient!). We happen to know/control
 * lmdb-js, so we basically use the same code as the lmdb-js C code uses for reading and interpreting this log of
 * write instructions. We can then use this to delegate to updates to our map of subscribers.
 * @param path
 * @param buffers
 * @param flag_position
 */
function notifyFromTransactionDataSharedBuffers(path, buffers, flag_position) {
	const HAS_KEY = 4;
	const HAS_VALUE = 2;
	const CONDITIONAL = 8;
	const TXN_DELIMITER = 0x8000000;
	const COMPRESSIBLE = 0x100000;
	const SET_VERSION = 0x200;
	if (!all_subscriptions) return;
	const subscriptions = all_subscriptions[path];
	if (!subscriptions) return; // if no subscriptions to this env path, don't need to read anything
	for (const array_buffer of buffers) {
		const uint32 = new Uint32Array(array_buffer);
		const buffer = Buffer.from(array_buffer);
		let first = true;
		do {
			const flag = uint32[flag_position++];
			const operation = flag;
			if (flag & TXN_DELIMITER && !first) break;
			first = false;
			if (flag & HAS_KEY) {
				const dbi = uint32[flag_position++];
				const key_size = uint32[flag_position++];
				const key_position = flag_position << 2;
				const dbi_subscriptions = subscriptions[dbi];
				// only read the key if there are subscriptions for this dbi
				const key = dbi_subscriptions && readKey(buffer, key_position, key_position + key_size);
				// but we still need to track our position
				flag_position = ((key_position + key_size + 16) & ~7) >> 2;
				if (flag & HAS_VALUE) {
					if (flag & COMPRESSIBLE) flag_position += 4;
					else flag_position += 2;
				}
				if (flag & SET_VERSION) {
					flag_position += 2;
				}
				const key_subscriptions = dbi_subscriptions?.get(key);
				//console.log(threadId, 'change to', key, 'listeners', handlers?.length, 'flag_position', flag_position);
				if (key_subscriptions) {
					for (const subscription of key_subscriptions) {
						try {
							subscription.listener(key);
						} catch (error) {
							console.error(error);
							info(error);
						}
					}
				}
				for (const subscription of dbi_subscriptions.allKeys) {
					try {
						subscription.listener(key);
					} catch (error) {
						console.error(error);
						info(error);
					}
				}
			} else {
				flag_position++;
			}
		} while (flag_position < uint32.length);
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
		for (const subscription of table_subscriptions.allKeys) {
			try {
				if (subscription.crossThreads === false && !same_thread) continue;
				subscription.listener(record_key, audit_record);
			} catch (error) {
				console.error(error);
				info(error);
			}
		}
		const key_subscriptions = table_subscriptions.get(record_key);
		if (!key_subscriptions) continue;
		if (key_subscriptions) {
			for (const subscription of key_subscriptions) {
				if (subscription.startTime - 2 > txn_time) {
					// allow for a couple milliseconds of skew
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
				if (next.meta && next.meta.store === audit_store && next.meta.key) audit_ids.push(next.meta.key);
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
