// #1407/#1411 — custom-resource-handler over-time atomicity regression anchor.
//
// A single HTTP request to a custom Resource runs inside ONE database transaction (server/REST.ts
// wraps the handler in transaction(request, ...)). Every put() call on this context's transaction
// resets the long-transaction monitor's `timeout` (DatabaseTransaction.ts getReadTxn()), so the
// monitor only fires when a write is followed by an IDLE async suspend (a bare await/slow external
// I/O) with no intervening write — bulk writes never trigger it. That is the exact "silent
// partial drop" trigger flagged against #1407 from the custom-resource-handler side: a handler
// writes a row, awaits something slow (> storage.maxTransactionOpenTime), then writes a second
// row. Pre-#1411 the monitor force-committed the pre-await write mid-handler and the post-await
// write landed on a fresh implicit txn — both survived individually but the request's atomicity
// was broken (and worse, a handler that fails after the force-commit would drop the post-await
// write while keeping the pre-await one). Post-#1411 the whole handler must fail atomically:
// neither row persists and the caller gets a non-2xx error instead of a silent 200.
//
// POST /Handler/ { holdMs } — writes the "pre" row, awaits holdMs (idle, no intervening write) so
// the monitor's over-time tick fires mid-handler, then writes the "post" row on the same (now
// aborted/poisoned, post-#1411) transaction.
export class Handler extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const holdMs = b.holdMs != null ? Number(b.holdMs) : 4000;
		await tables.Row.put({ id: 'pre', phase: 'pre' });
		await new Promise((resolve) => setTimeout(resolve, holdMs));
		await tables.Row.put({ id: 'post', phase: 'post' });
		return { ok: true };
	}
}
