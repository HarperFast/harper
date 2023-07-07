import { getNextMonotonicTime } from '../utility/lmdb/commonUtility';
import { Request } from './ResourceInterface';

export function transaction<T>(request: Request, callback: (request: Request) => T): T;
export function transaction<T>(callback: (request: Request) => T): T;
/**
 * Start and run a new transaction. This can be called with a request to hold the transaction, or a new request object will be created
 * @param request
 * @param callback
 * @returns
 */
export function transaction<T>(request: Request | ((request: Request) => T), callback?: (request: Request) => T): T {
	if (!callback) {
		// optional first argument, handle case of no request
		callback = request;
		request = {};
	} else if (!request) request = {}; // request argument included, but null or undefined, so create anew one
	else if (request.context?.transaction && typeof callback === 'function') return callback(request as Request); // nothing to be done, already in transaction
	if (typeof callback !== 'function') throw new Error('Callback function must be provided to transaction');
	let context = request.context;
	if (!context) {
		if (context === null) context = request.context = {};
		else context = request;
	}
	const transaction = (context.transaction = new TransactionSet());
	transaction.timestamp = context.timestamp || getNextMonotonicTime();
	context.resourceCache = [];
	let result;
	try {
		result = callback(request);
		if (result?.then) {
			return result.then(
				(result) => {
					const committed = transaction.commit();
					return committed.then ? committed.then(() => result) : result;
				},
				(error) => {
					transaction.abort();
					throw error;
				}
			);
		}
	} catch (error) {
		transaction.abort();
		throw error;
	}
	const committed = transaction.commit();
	return committed.then ? committed.then(() => result) : result;
}

class TransactionSet extends Array {
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
		for (let i = 0; i < l; i++) {
			const txn = this[i];
			// TODO: If we have multiple commits in a single resource instance, need to maintain
			// databases with waiting flushes to resolve at the end when a flush is requested.
			const resolution = txn.commit(flush);
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
