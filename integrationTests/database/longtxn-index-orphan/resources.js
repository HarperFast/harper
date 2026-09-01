// QA-601 — over-time write transaction x secondary index, multi-store `next`-chain corner.
//
// Mechanism (resources/DatabaseTransaction.ts, resources/Table.ts txnForContext, read at
// harper @ 3dbcf7b9e): the long-transaction monitor's abortDueToTimeout() poisons every link
// of a transaction's multi-store `next` chain that EXISTS at the moment it fires:
//   for (let txn = this; txn; txn = txn.next) { txn.timedOut = true; txn.open = CLOSED; }
// HYPOTHESIS (disproven — see the test file's header for the full trace): if table B is
// touched for the first time AFTER the head (table A) is poisoned, txnForContext would create
// B's `next` link fresh, inheriting `open = CLOSED` but not `timedOut`, and slip through
// save()'s `immediateCommit` branch to durably commit standalone. Empirically this does NOT
// happen: resources/Resource.ts's `applyContext` (the transactional() wrapper behind every
// `tables.X.put()` call) checks `context.transaction.timedOut` BEFORE txnForContext is ever
// reached for the second store, so table B's write throws transactionOpenTooLongError
// immediately — confirmed via the console.error trace below (`next.open=undefined` — table B's
// `next` link is never even created). The console.error calls are debug instrumentation kept in
// place so the trace is visible in the test's captured stdout; they are load-bearing evidence,
// not incidental logging.
//
// Endpoints:
//   POST /CrossOvertime/ { tag, holdMs }  — write A, hold past threshold, write B (the probe)
//   POST /CrossBaseline/ { tag }          — write A then B quickly, no hold (control)
//   GET  /DumpA/ /DumpB/                  — raw primary-store scan [{id,tag}]
//   GET  /ReadyProbe/                     — { ok: true } readiness check

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// POST /CrossOvertime/ { tag, holdMs }
export class CrossOvertime extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const tag = b.tag || 'cross';
		const holdMs = b.holdMs != null ? Number(b.holdMs) : 3000;
		const t0 = Date.now();
		const ctx = this.getContext();
		console.error(`[QA601-DEBUG ${tag}] start ctx.transaction=${!!ctx.transaction}`);
		// Phase 1: write TABLE A — creates+tracks the head DatabaseTransaction (A's store).
		await tables.TableA.put({ id: `${tag}-a`, tag, payload: 'A' });
		console.error(
			`[QA601-DEBUG ${tag}] after A write: open=${ctx.transaction?.open} timedOut=${ctx.transaction?.timedOut} db=${ctx.transaction?.db?.name ?? ctx.transaction?.db?.tableName ?? 'n/a'}`
		);
		// Phase 2: hold past threshold — monitor should fire on the head here. TableB's `next`
		// link does not exist yet, so only the head is in the poison walk.
		await sleep(holdMs);
		console.error(
			`[QA601-DEBUG ${tag}] after sleep: open=${ctx.transaction?.open} timedOut=${ctx.transaction?.timedOut} next=${!!ctx.transaction?.next}`
		);
		// Phase 3: FIRST touch of TABLE B, after the head was (predicted) poisoned+aborted.
		let bError = null;
		let bResult = null;
		try {
			bResult = await tables.TableB.put({ id: `${tag}-b`, tag, payload: 'B' });
			console.error(`[QA601-DEBUG ${tag}] B write returned OK, result=${JSON.stringify(bResult)}`);
		} catch (error) {
			bError = { message: error.message, code: error.statusCode ?? error.code };
			console.error(`[QA601-DEBUG ${tag}] B write THREW: ${error.message} code=${error.statusCode ?? error.code}`);
		}
		console.error(
			`[QA601-DEBUG ${tag}] after B write attempt: head.open=${ctx.transaction?.open} head.timedOut=${ctx.transaction?.timedOut} ` +
				`next.open=${ctx.transaction?.next?.open} next.timedOut=${ctx.transaction?.next?.timedOut}`
		);
		return { ok: true, tag, elapsedMs: Date.now() - t0, bError };
	}
}

// POST /CrossBaseline/ { tag } — control: write A then B quickly, well under threshold.
export class CrossBaseline extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const tag = b.tag || 'baseline';
		await tables.TableA.put({ id: `${tag}-a`, tag, payload: 'A' });
		await tables.TableB.put({ id: `${tag}-b`, tag, payload: 'B' });
		return { ok: true, tag };
	}
}

// GET /DumpA/ -> [{id,tag}]
export class DumpA extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const r of tables.TableA.search({})) out.push({ id: r.id, tag: r.tag });
		return out;
	}
}

// GET /DumpB/ -> [{id,tag}]
export class DumpB extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const r of tables.TableB.search({})) out.push({ id: r.id, tag: r.tag });
		return out;
	}
}

// GET /ReadyProbe/ -> { ok: true }
export class ReadyProbe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}
