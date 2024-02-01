import { Request } from './ResourceInterface';
import { _assignPackageExport } from '../index';
import { CONTEXT } from './Resource';
import { DatabaseTransaction, FinishedTransaction, TRANSACTION_STATE } from './DatabaseTransaction';

export function transaction<T>(context: Request, callback: (transaction: TransactionSet) => T, options?: any): T;
export function transaction<T>(callback: (transaction: TransactionSet) => T): T;
/**
 * Start and run a new transaction. This can be called with a request to hold the transaction, or a new request object will be created
 * @param context
 * @param callback
 * @returns
 */
export function transaction<T>(
	context: Request | ((transaction: TransactionSet) => T),
	callback?: (transaction: TransactionSet) => T,
	options?: any
): T {
	if (!callback) {
		// optional first argument, handle case of no request
		callback = context;
		context = {};
	} else if (!context) context = {}; // request argument included, but null or undefined, so create anew one
	else if (context?.transaction?.open === TRANSACTION_STATE.OPEN && typeof callback === 'function')
		return callback(context.transaction); // nothing to be done, already in open transaction
	if (typeof callback !== 'function') throw new Error('Callback function must be provided to transaction');
	const transaction = (context.transaction = new DatabaseTransaction());
	if (context.timestamp) transaction.timestamp = context.timestamp;
	transaction[CONTEXT] = context;
	// create a resource cache so that multiple requests to the same resource return the same resource
	if (!context.resourceCache) context.resourceCache = [];
	let result;
	try {
		result = callback(transaction);
		if (result?.then) {
			return result.then(onComplete, onError);
		}
	} catch (error) {
		onError(error);
	}
	return onComplete(result);
	// when the transaction function completes, run this to commit the transaction
	function onComplete(result) {
		const committed = transaction.commit({ letItLinger: options?.letItLinger });
		if (committed.then) {
			return committed.then(() => {
				return result;
			});
		} else {
			return result;
		}
	}
	// if the transaction function throws an error, we abort
	function onError(error) {
		transaction.abort({});
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
