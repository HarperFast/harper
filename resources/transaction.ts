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
	}
	if (typeof callback !== 'function') throw new Error('Callback function must be provided to transaction');
	const transaction = (request.transaction = new TransactionSet());
	transaction.timestamp = request.timestamp || getNextMonotonicTime();
	request.resourceCache = new Map();
	let result;
	try {
		result = callback(request);
		if (result?.then) {
			return result.then(
				(result) => {
					transaction.commit();
					return result;
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
	transaction.commit();
	return result;
}

class TransactionSet extends Array {
	/**
	 * Commit the resource transaction(s). This commits any transactions that have started as part of the resolution
	 * of this resource, and frees any read transaction.
	 */
	async commit(flush = true): Promise<{ txnTime: number }> {
		const commits = [];
		// this can grow during the commit phase, so need to always check length
		try {
			for (let i = 0; i < this.length; i++) {
				const txn = this[i];
				txn.validate?.();
			}
			for (let i = 0; i < this.length; ) {
				for (let l = this.length; i < l; i++) {
					const txn = this[i];
					// TODO: If we have multiple commits in a single resource instance, need to maintain
					// databases with waiting flushes to resolve at the end when a flush is requested.
					commits.push(txn.commit(flush));
				}
				await Promise.all(commits);
			}
			return { txnTime: this.timestamp };
		} finally {
			this.length = 0;
		}
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
