import type { Context } from './ResourceInterface.ts';
import { _assignPackageExport } from '../globals.js';
import { DatabaseTransaction, type Transaction, TRANSACTION_STATE } from './DatabaseTransaction.ts';
import { AsyncLocalStorage } from 'async_hooks';

export const contextStorage = new AsyncLocalStorage<Context>();

export function transaction<T>(context: Context, callback: (transaction: Transaction) => T): T;
export function transaction<T>(callback: (transaction: Transaction) => T): T;
/**
 * Start and run a new transaction. This can be called with a request to hold the transaction, or a new request object will be created
 * @param ctx
 * @param callback
 * @returns
 */
export function transaction<T>(
	ctx: Context | ((transaction: Transaction) => T),
	callback?: (transaction: Transaction) => T
): T {
	let context: Context;
	let asyncStorageContext;
	if (typeof ctx === 'function') {
		// optional first argument, handle case of no request
		callback = ctx;
		asyncStorageContext = contextStorage.getStore();
		context = asyncStorageContext ?? {};
	} else {
		// request argument included, but null or undefined, so maybe create a new one
		context = ctx ?? (asyncStorageContext = contextStorage.getStore()) ?? {};
	}

	if (typeof callback !== 'function') {
		throw new TypeError('Callback function must be provided to transaction');
	}
	if (context?.transaction?.open === TRANSACTION_STATE.OPEN && typeof callback === 'function') {
		return callback(context.transaction); // nothing to be done, already in open transaction
	}

	const transaction = new DatabaseTransaction();
	context.transaction = transaction;
	if (context.timestamp) transaction.timestamp = context.timestamp;
	if (context.replicatedConfirmation) transaction.replicatedConfirmation = context.replicatedConfirmation;
	transaction.setContext(context);

	// create a resource cache so that multiple requests to the same resource return the same resource
	if (!context.resourceCache) context.resourceCache = new Map();
	let result;
	try {
		result =
			(context as any).isExplicit || asyncStorageContext
				? callback(transaction)
				: contextStorage.run(context, () => callback(transaction));
		if ((result as any)?.then) {
			return (result as any).then(onComplete, onError);
		}
	} catch (error) {
		onError(error);
	}
	return onComplete(result);
	// when the transaction function completes, run this to commit the transaction
	function onComplete(result) {
		const committed = transaction.commit({ doneWriting: true });
		if ((committed as any).then) {
			return (committed as any).then(() => {
				return result;
			});
		} else {
			return result;
		}
	}
	// if the transaction function throws an error, we abort
	function onError(error) {
		transaction.abort();
		throw error;
	}
}

_assignPackageExport('transaction', transaction);

transaction.commit = function (contextSource) {
	const transaction = (contextSource.getContext?.() || contextSource)?.transaction;
	if (!transaction) throw new Error('No active transaction is available to commit');
	return transaction.commit();
};
transaction.abort = function (contextSource) {
	const transaction = (contextSource.getContext?.() || contextSource)?.transaction;
	if (!transaction) throw new Error('No active transaction is available to abort');
	return transaction.abort();
};
