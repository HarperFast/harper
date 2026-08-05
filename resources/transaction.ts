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

	// Abort promptly on client disconnect (harper#2001) instead of waiting on the callback or the
	// long-transaction monitor. `signal` is unset for non-request contexts. Removed at the top of
	// onComplete/onError so it can only fire while the callback is still pending.
	//
	// Gated the same way the long-transaction monitor gates abortDueToTimeout (DatabaseTransaction.ts's
	// startMonitoringTxns): only a write-bearing transaction is poisoned. A read-only transaction (e.g. a
	// large search()/export) can have live iterators streaming through its native handle — aborting mid-
	// stream would free that handle out from under them, not just close it early. sourceApply/isReplay
	// transactions (replication peer / external caching source / crash-recovery replay) have no resume
	// path, so dropping their write on disconnect would diverge them permanently (harper-pro#348) — same
	// exclusion the monitor already makes.
	//
	// No `signal.aborted` fast path: unlike the monitor (a fresh timer each tick), an AbortSignal stays
	// aborted forever once fired, and the same signal can be shared by later transaction() calls on the
	// same context (ALS inheritance, a spread-copied context) — including deliberate post-disconnect
	// compensation work (a `finally` releasing a claim). Only a disconnect that happens WHILE this
	// specific transaction is open should poison it; one that already happened before it was created
	// should not.
	const signal = context.signal;
	let onDisconnect: (() => void) | undefined;

	let result;
	try {
		result =
			(context as any).isExplicit || asyncStorageContext
				? callback(transaction)
				: contextStorage.run(context, () => callback(transaction));
		if ((result as any)?.then) {
			// A synchronous callback can't yield to the event loop, so an abort event physically cannot
			// fire during it — only arm the listener once we know the callback is still in flight. Safe to
			// do here (rather than before calling callback) because no microtask has run yet.
			if (signal) {
				onDisconnect = () => {
					try {
						if (
							transaction.open === TRANSACTION_STATE.OPEN &&
							transaction.hasPendingWrites() &&
							!transaction.sourceApply &&
							!transaction.isReplay
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
			return (committed as any).then(() => result, (error) => onCommitError(error, result));
		} else {
			return result;
		}
	}
	function onCommitError(error, result) {
		result?.onDone?.();
		transaction.abort(transaction.timedOut || transaction.disconnected);
		throw error;
	}
	// if the transaction function throws an error, we abort
	function onError(error) {
		if (onDisconnect) signal.removeEventListener('abort', onDisconnect);
		transaction.abort(transaction.timedOut || transaction.disconnected);
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
