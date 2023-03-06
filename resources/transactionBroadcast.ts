import { readKey } from 'ordered-binary';
import { info } from '../utility/logging/harper_logger';
import { threadId } from 'worker_threads';
import { onMessageFromWorkers, broadcast } from '../server/threads/manage-threads';
const TRANSACTION_EVENT_TYPE = 'transaction';

let all_subscriptions;
export function addSubscription(path, dbi, key, listener?: (key) => any) {
	// set up the subscriptions map. We want to just use a single map (per table) for efficient delegation
	// (rather than having every subscriber filter every transaction)
	if (!all_subscriptions) {
		onMessageFromWorkers((event) => {
			if (event.type === TRANSACTION_EVENT_TYPE) {
				let flag_position = event.start || 2;
				let buffers = event.buffers;
				let path = event.path;
				notifyFromTransactionData(path, buffers, flag_position);
			}
		});
		all_subscriptions = Object.create(null); // using it as a map that doesn't change much
	}
	let env_subscriptions = all_subscriptions[path] || (all_subscriptions[path] = []);
	let dbi_subscriptions = env_subscriptions[dbi] || (env_subscriptions[dbi] = new Map());
	let subscriptions: any[] = dbi_subscriptions.get(key);

	let subscription = {
		callback: listener,
		end() {
			// cleanup
			subscriptions.splice(subscriptions.indexOf(subscription), 1);
			if (subscriptions.length === 0) {
				dbi_subscriptions.delete(key);
				if (dbi_subscriptions.size === 0) {
					delete env_subscriptions[dbi];
				}
			}
		}
	};
	if (subscriptions) subscriptions.push(subscription);
	else dbi_subscriptions.set(key, subscriptions = [subscription]);
	return subscription;
}
function notifyFromTransactionData(path, buffers, flag_position) {
	const HAS_KEY = 4;
	const HAS_VALUE = 2;
	const CONDITIONAL = 8;
	const TXN_DELIMITER = 0x8000000;
	const COMPRESSIBLE = 0x100000;
	const SET_VERSION = 0x200;
	if (!all_subscriptions) return;
	let subscriptions = all_subscriptions[path];
	if (!subscriptions) return; // if no subscriptions to this env path, don't need to read anything
	for (let array_buffer of buffers) {
		let uint32 = new Uint32Array(array_buffer);
		let buffer = Buffer.from(array_buffer);
		let first = true;
		do {
			let flag = uint32[flag_position++];
			let operation = flag;
			if (flag & TXN_DELIMITER && !first)
				break;
			first = false;
			if (flag & HAS_KEY) {
				let dbi = uint32[flag_position++];
				let key_size = uint32[flag_position++];
				let key_position = flag_position << 2;
				let dbi_subscriptions = subscriptions[dbi];
				// only read the key if there are subscriptions for this dbi
				let key = dbi_subscriptions && readKey(buffer, key_position, key_position + key_size);
				// but we still need to track our position
				flag_position = ((key_position + key_size + 16) & (~7)) >> 2;
				if (flag & HAS_VALUE) {
					if (flag & COMPRESSIBLE)
						flag_position += 4;
					else
						flag_position += 2;
				}
				if (flag & SET_VERSION) {
					flag_position += 2;
				}
				let subscriptions = dbi_subscriptions?.get(key);
				//console.log(threadId, 'change to', key, 'listeners', handlers?.length, 'flag_position', flag_position);
				if (subscriptions) subscriptions.forEach(subscription => {
					try {
						subscription.callback(key);
					} catch(error) {
						console.error(error);
						info(error);
					}
				});
			} else {
				flag_position++;
			}
		} while (flag_position < uint32.length);
	}
}

export function listenToCommits(primary_dbi) {
	let lmdb_env = primary_dbi.env;
	if (!lmdb_env.hasBroadcastListener) {
		lmdb_env.hasBroadcastListener = true;
		let path = lmdb_env.path;

		primary_dbi.on('aftercommit', ({next, last}) => {
			// after each commit, broadcast the transaction to all threads so subscribers can read the
			// transactions and find changes of interest. We try to use the same binary format for
			// transactions that is used by lmdb-js for minimal modification and since the binary
			// format can readily be shared with other threads
			let transaction_buffers = [];
			let last_uint32;
			let start;
			// get all the buffers (and starting position of the first) in this transaction
			do {
				if (next.uint32 !== last_uint32) {
					last_uint32 = next.uint32;
					if (last_uint32) {
						if (start === undefined)
							start = next.flagPosition;
						transaction_buffers.push(last_uint32.buffer);
					}
				}
				next = next.next;
			} while (next !== last);
			// broadcast all the transaction buffers so they can be (sequentially) read and subscriptions messages
			// delivered on all other threads
			broadcast({
				type: TRANSACTION_EVENT_TYPE,
				path,
				buffers: transaction_buffers,
				start,
			});
			// and notify on our own thread too
			notifyFromTransactionData(path, transaction_buffers, start);
		});
	}
}