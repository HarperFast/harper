import type { Context } from './ResourceInterface.ts';
import { _assignPackageExport } from '../globals.js';
import {
	DatabaseTransaction,
	isReleasedTransaction,
	type Transaction,
	TRANSACTION_STATE,
} from './DatabaseTransaction.ts';
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
	if (typeof ctx === 'function') {
		// optional first argument, handle case of no request
		callback = ctx;
		context = contextStorage.getStore() ?? {};
	} else {
		// The released placeholder is an absent argument, not a context: normalized before the fallback
		// chain below so it resolves to the ambient store exactly as the `null` it replaced did, rather
		// than to a bare `{}` that would drop the caller's user, session and timestamp.
		const contextArg = isReleasedTransaction(ctx) ? undefined : ctx;
		// request argument included, but null or undefined, so maybe create a new one
		context = contextArg ?? contextStorage.getStore() ?? {};
	}

	if (typeof callback !== 'function') {
		throw new TypeError('Callback function must be provided to transaction');
	}
	if (context?.transaction?.open === TRANSACTION_STATE.OPEN && typeof callback === 'function') {
		const invokeCallback = () => callback(context.transaction);
		return contextStorage.getStore() === context ? invokeCallback() : contextStorage.run(context, invokeCallback);
	}

	const transaction = new DatabaseTransaction();
	context.transaction = transaction;
	if (context.timestamp) transaction.timestamp = context.timestamp;
	if (context.replicatedConfirmation) transaction.replicatedConfirmation = context.replicatedConfirmation;
	if (context.sourceApply) transaction.sourceApply = true;
	transaction.setContext(context);
	let result;
	try {
		const invokeCallback = () => callback(transaction);
		result = contextStorage.getStore() === context ? invokeCallback() : contextStorage.run(context, invokeCallback);
		if ((result as any)?.then) {
			return (result as any).then(onComplete, onError);
		}
	} catch (error) {
		onError(error);
	}
	return onComplete(result);
	// when the transaction function completes, run this to commit the transaction
	function onComplete(result) {
		try {
			const committed = transaction.commit({ doneWriting: true });
			if ((committed as any).then) {
				return (committed as any).then(() => result);
			} else {
				return result;
			}
		} catch (error) {
			return onCommitError(error);
		}
	}
	function onCommitError(error) {
		try {
			transaction.abort();
		} catch {}
		throw error;
	}
	// if the transaction function throws an error, we abort
	function onError(error) {
		try {
			transaction.abort();
		} catch {}
		throw error;
	}
}

_assignPackageExport('transaction', transaction);

// Only a context that never had a transaction has none to act on: a completed transaction still in the
// slot must no-op here, as it always did, or a checkpointing loop that commits every Nth row fails on
// its second checkpoint.
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
