import type { Context } from './ResourceInterface.ts';
import { _assignPackageExport } from '../globals.js';
import {
	DatabaseTransaction,
	isJoinableScope,
	isReleasedTransaction,
	TRANSACTION_STATE,
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

	// Abort promptly on client disconnect (harper#2001) rather than waiting on the callback or the
	// long-transaction monitor. Gated like the monitor gates abortDueToTimeout: write-bearing only, never
	// sourceApply/isReplay (no resume path, harper-pro#348). No `signal.aborted` fast path — a signal
	// stays aborted forever and later transaction() calls share it, so only a disconnect that happens
	// while THIS transaction is open poisons it. That is not a compensation-work escape hatch, and the
	// static-API and transaction() spellings of the same post-disconnect write behave oppositely.
	// DESIGN.md carries the full reasoning for all three.
	const signal = context.signal;
	let onDisconnect: (() => void) | undefined;

	let result;
	try {
		result =
			(context as any).isExplicit || asyncStorageContext
				? callback(transaction)
				: contextStorage.run(context, () => callback(transaction));
		if ((result as any)?.then) {
			// A synchronous callback cannot yield to the event loop, so arming before it would be pure
			// overhead; no microtask has run yet, so nothing was missed.
			if (signal) {
				onDisconnect = () => {
					try {
						// isCommittingWrites() is not redundant: commit() marks itself CLOSED and clears its
						// staged writes before the native commit settles, so for that whole window a
						// write-bearing transaction reads as idle and read-only.
						if (
							!transaction.sourceApply &&
							!transaction.isReplay &&
							((transaction.open === TRANSACTION_STATE.OPEN && transaction.hasPendingWrites()) ||
								transaction.isCommittingWrites())
						) {
							transaction.abortDueToDisconnect();
						}
					} catch (error) {
						harperLogger.debug?.('aborting transaction on client disconnect', error);
					}
				};
				signal.addEventListener('abort', onDisconnect, { once: true });
			}
			return (result as any).then(onComplete, onError);
		}
	} catch (error) {
		onError(error);
	}
	return onComplete(result);
	// when the transaction function completes, run this to commit the transaction
	function onComplete(result) {
		if (onDisconnect) signal.removeEventListener('abort', onDisconnect);
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
		abortAndThrow(error);
	}
	// if the transaction function throws an error, we abort
	function onError(error) {
		if (onDisconnect) signal.removeEventListener('abort', onDisconnect);
		abortAndThrow(error);
	}
	function abortAndThrow(error): never {
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
			// Nothing was returned, so no live response can own an iterator opened inside this call: hand
			// their read references back now, or the retained handle waits on an onDone() nobody will call.
			transaction.closeOwnedReadIterators();
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
