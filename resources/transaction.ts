import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import { Request } from './ResourceInterface';
import { _assignPackageExport } from '../index';
import { CONTEXT } from './Resource';

export function transaction<T>(context: Request, callback: (transaction: TransactionSet) => T): T;
export function transaction<T>(callback: (transaction: TransactionSet) => T): T;
/**
 * Start and run a new transaction. This can be called with a request to hold the transaction, or a new request object will be created
 * @param context
 * @param callback
 * @returns
 */
export function transaction<T>(
	context: Request | ((transaction: TransactionSet) => T),
	callback?: (transaction: TransactionSet) => T
): T {
	if (!callback) {
		// optional first argument, handle case of no request
		callback = context;
		context = {};
	} else if (!context) context = {}; // request argument included, but null or undefined, so create anew one
	else if (context?.transaction && typeof callback === 'function') return callback(context.transaction); // nothing to be done, already in transaction
	if (typeof callback !== 'function') throw new Error('Callback function must be provided to transaction');
	const transaction = (context.transaction = new TransactionSet());
	if (context.timestamp) transaction.timestamp = context.timestamp;
	transaction[CONTEXT] = context;
	context.resourceCache = [];
	let result;
	try {
		result = callback(transaction);
		if (result?.then) {
			return result.then(onSuccess, onError);
		}
	} catch (error) {
		onError(error);
	}
	return onSuccess(result);
	function onSuccess(result) {
		const committed = transaction.commit();
		if (committed.then) {
			return committed.then(() => {
				context.transaction = null;
				return result;
			});
		} else {
			context.transaction = null;
			return result;
		}
	}
	function onError(error) {
		transaction.abort();
		context.transaction = null;
		throw error;
	}
}

_assignPackageExport('transaction', transaction);

transaction.commit = function (context_source) {
	const transaction = (context_source[CONTEXT] || context_source)?.transaction;
	if (!transaction) throw new Error('No active transaction is available to commit');
	return transaction.commit();
};
transaction.abort = function (context_source) {
	const transaction = (context_source[CONTEXT] || context_source)?.transaction;
	if (!transaction) throw new Error('No active transaction is available to abort');
	return transaction.abort();
};

class TransactionSet extends Array {
	timestamp: number;
	/**
	 * Commit the resource transaction(s). This commits any transactions that have started as part of the resolution
	 * of this resource, and frees any read transaction.
	 */
	commit(flush = true): Promise<{ txnTime: number }> {
		const commits = [];
		// this can grow during the commit phase, so need to always check length
		const l = this.length;
		for (let i = 0; i < l; i++) {
			const txn = this[i];
			txn.validate?.();
		}
		if (!this.timestamp) this.timestamp = getNextMonotonicTime();
		for (let i = 0; i < l; i++) {
			const txn = this[i];
			// TODO: If we have multiple commits in a single resource instance, need to maintain
			// databases with waiting flushes to resolve at the end when a flush is requested.
			const resolution = txn.commit(this.timestamp, flush);
			if (resolution?.then) commits.push(resolution);
		}
		if (commits.length > 0)
			return Promise.all(commits).then(() => {
				// remove all the committed transactions
				this.splice(0, l);
				// and call again to process any more, or just return timestamp
				return this.commit(flush);
			});
		else if (this.length > l) {
			this.splice(0, l);
			// and call again to process any more, or just return timestamp
			return this.commit(flush);
		}

		this.length = 0;
		return { txnTime: this.timestamp };
	}
	abort() {
		for (const txn of this) {
			txn.abort?.();
		}
	}
	doneReading() {
		for (const txn of this) {
			txn.doneReading?.();
		}
	}
}
