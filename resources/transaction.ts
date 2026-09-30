import type { Context } from './ResourceInterface.ts';
import { _assignPackageExport } from '../globals.js';
import {
	DatabaseTransaction,
	isJoinableScope,
	isReleasedTransaction,
	type Transaction,
} from './DatabaseTransaction.ts';
import { AsyncLocalStorage } from 'async_hooks';
import * as harperLogger from '../utility/logging/harper_logger.ts';

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
		// The released placeholder is an absent argument, not a context: normalized before the fallback
		// chain below so it resolves to the ambient store exactly as the `null` it replaced did, rather
		// than to a bare `{}` that would drop the caller's user, session and timestamp.
		const contextArg = isReleasedTransaction(ctx) ? undefined : ctx;
		// request argument included, but null or undefined, so maybe create a new one
		context = contextArg ?? (asyncStorageContext = contextStorage.getStore()) ?? {};
	}

	if (typeof callback !== 'function') {
		throw new TypeError('Callback function must be provided to transaction');
	}
	if (isJoinableScope(context?.transaction) && typeof callback === 'function') {
		return callback(context.transaction); // nothing to be done, already in open transaction
	}

	// scopeOwned: onComplete/onError below guarantee this instance a final commit or an abort, which is
	// what lets a mid-scope commit rotate it instead of leaving later writes to commit themselves.
	const transaction = new DatabaseTransaction({ scopeOwned: true });
	context.transaction = transaction;
	if (context.timestamp) transaction.timestamp = context.timestamp;
	if (context.replicatedConfirmation) transaction.replicatedConfirmation = context.replicatedConfirmation;
	if (context.sourceApply) transaction.sourceApply = true;
	transaction.setContext(context);

	// Cancellation belongs to the request (harper#2001): once its signal aborts, the chain refuses new
	// writes and releases what it staged (DatabaseTransaction.admitRequestWrite). sourceApply is exempt,
	// having no resume path (harper-pro#348); work that must outlive the client runs on a context without
	// the signal (resources/DESIGN.md).
	if (!transaction.sourceApply) transaction.requestSignal = context.signal;

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
		let committed;
		try {
			committed = transaction.commit({ doneWriting: true });
		} catch (error) {
			return onCommitError(error, result);
		}
		if ((committed as any).then) {
			return (committed as any).then(
				() => result,
				(error) => onCommitError(error, result)
			);
		} else {
			return result;
		}
	}
	function onCommitError(error, result) {
		try {
			if (typeof result?.onDone === 'function') result.onDone();
		} catch (cleanupError) {
			harperLogger.debug?.('closing results after a failed commit', cleanupError);
		}
		abortAndThrow(error, false);
	}
	// if the transaction function throws an error, we abort
	function onError(error) {
		abortAndThrow(error, true);
	}
	function abortAndThrow(error, callbackThrew: boolean): never {
		// A commit attempt that has not reached its native outcome owns its own teardown — a handler that
		// fired txn.commit() without awaiting it can get here while it is still running, and aborting
		// would clear the writes it is committing and abort the handle it is committing them through.
		// Ownership of the scope still ends here, or that attempt would rotate the instance back OPEN with
		// no wrapper left to commit or abort it; abandonScope() also defers the iterator cleanup below to
		// the point where the attempt settles.
		if (transaction.isChainCommitting()) {
			transaction.abandonScope();
		} else {
			try {
				// "retain only while read iterators still own the handle", the same rule
				// abortAfterCommitError uses — so the two layers cannot undo each other one frame apart.
				transaction.abort(true);
			} catch (abortError) {
				harperLogger.debug?.('aborting transaction after an error', abortError);
			}
			// Only when the callback threw: then nothing was returned, so no live response can own an iterator
			// it opened, and the retained handle would wait on an onDone() nobody will call. A callback that
			// completed may have handed an iterator out; the monitor reclaims it if that consumer abandons it.
			if (callbackThrew) transaction.closeOwnedReadIterators();
		}
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
