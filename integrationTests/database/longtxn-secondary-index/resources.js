// QA-176 — long-transaction monitor (force/abort) vs secondary-index consistency.
//
// Mechanism under test: a single HTTP request to a custom Resource runs inside ONE database
// transaction (server/REST.ts wraps the handler in transaction(request, ...)). Every
// tables.Doc write joins that same txn. The long-transaction MONITOR (resources/
// DatabaseTransaction.ts + LMDBTransaction.ts) runs on a setInterval(maxTransactionOpenTime)
// timer and, when a tracked txn's `timeout` reaches <= 0, force-handles it:
//   pre-#1411 (this dist, 7aaa5a152): force-COMMIT mid-stream, then reset timeout.
//   post-#1411: abort + poison BOTH the primary and secondary-index engines.
// The over-time log line is: "Transaction was open too long and has been committed, table: ..."
//
// To cross the threshold from a single request we hold ONE txn open across writes that span
// MORE than maxTransactionOpenTime of wall time, by awaiting sleeps BETWEEN indexed writes.
// While the txn is open the monitor must fire (force-commit / abort) underneath us. Then we
// continue writing into the same (now reset/poisoned) context txn. The consistency oracle is
// run from the test: every search_by_value(bucket) hit must have a live base row with that
// bucket (no phantom), and every base row must appear in its bucket's index search (no missing).
//
// Endpoints (POST body { count, bucket?, holdMs?, sleepEach? }):
//   /SlowWrite — inserts `count` rows of bucket `bucket`, sleeping `sleepEach` ms BETWEEN each
//                write (default tuned so total wall > maxTransactionOpenTime) so the monitor
//                fires mid-stream. Returns { ok, count, elapsedMs } on normal completion.
//   /SlowThenHold — inserts `count` rows, then sleeps `holdMs` (>> threshold) holding the open
//                txn, then writes ONE final "marker" row, then returns. Forces the monitor to
//                act on a txn that still has pending writes, then we add a write after.
// GET  /Count/  — { count } exact base-table row count (full scan, index-independent).
// GET  /Dump/   — [{ id, bucket, seq }] every base row (full scan), the base oracle.

function pad(n) {
	return String(n).padStart(6, '0');
}
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// The long-transaction MONITOR (DatabaseTransaction.getReadTxn -> trackedTxns.add) only tracks a
// context transaction once a READ has opened a read-transaction on it. A search() iterator marks
// the read txn in-use (useReadTxn) and only releases it (doneReadTxn) when the iterator is FULLY
// consumed. So to hold ONE tracked transaction open across the over-time window we open a search
// iterator, pull a record (registering the txn), then interleave indexed writes + sleeps WITHOUT
// finishing the iterator. The same context txn now carries both the open read snapshot and the
// pending indexed writes, and the monitor force-commits/aborts it mid-flight.

// POST /SlowWrite/ { count, bucket, sleepEach } — open a held read iterator, then sleep BETWEEN
// indexed writes so the single tracked txn outlives maxTransactionOpenTime and the monitor fires.
export class SlowWrite extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const n = Number(b.count) || 0;
		const bucket = b.bucket || 'B';
		const sleepEach = b.sleepEach != null ? Number(b.sleepEach) : 350;
		const t0 = Date.now();
		// Open an iterator over the seed bucket and keep it open (don't consume fully) so the
		// context txn is tracked by the long-transaction monitor for the duration of this request.
		const iter = tables.Doc.search({ conditions: [{ attribute: 'bucket', value: '__seed__' }] })[
			Symbol.asyncIterator
		]();
		await iter.next(); // register a read txn on the context transaction
		try {
			for (let i = 0; i < n; i++) {
				await tables.Doc.put({ id: `${bucket}-${pad(i)}`, bucket, seq: i, payload: 'x'.repeat(48) });
				if (sleepEach > 0) await sleep(sleepEach);
			}
		} finally {
			await iter.return?.();
		}
		return { ok: true, count: n, bucket, elapsedMs: Date.now() - t0 };
	}
}

// POST /SlowThenHold/ { count, bucket, holdMs } — open a held read iterator, write `count` indexed
// rows, then HOLD the open tracked txn for holdMs (>> threshold) so the monitor force-handles a txn
// with the writes still pending, then write a final marker row AFTER the over-time event.
export class SlowThenHold extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const n = Number(b.count) || 0;
		const bucket = b.bucket || 'H';
		const holdMs = b.holdMs != null ? Number(b.holdMs) : 4000;
		const t0 = Date.now();
		const iter = tables.Doc.search({ conditions: [{ attribute: 'bucket', value: '__seed__' }] })[
			Symbol.asyncIterator
		]();
		await iter.next(); // register a read txn on the context transaction
		try {
			for (let i = 0; i < n; i++) {
				await tables.Doc.put({ id: `${bucket}-${pad(i)}`, bucket, seq: i, payload: 'y'.repeat(48) });
			}
			// hold the open tracked transaction across the monitor's over-time window
			await sleep(holdMs);
			// one more write AFTER the forced over-time event, on the (reset/poisoned) context txn
			await tables.Doc.put({ id: `${bucket}-marker`, bucket, seq: 9999, payload: 'marker' });
		} finally {
			await iter.return?.();
		}
		return { ok: true, count: n + 1, bucket, elapsedMs: Date.now() - t0 };
	}
}

// POST /Seed/ { bucket, count } — quick non-slow insert so the held iterators have rows to scan.
export class Seed extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const n = Number(b.count) || 3;
		const bucket = b.bucket || '__seed__';
		for (let i = 0; i < n; i++) {
			await tables.Doc.put({ id: `${bucket}-${pad(i)}`, bucket, seq: i, payload: 'seed' });
		}
		return { ok: true, count: n, bucket };
	}
}

// GET /Count/ -> { count } exact base row count (index-independent full scan).
export class Count extends Resource {
	static loadAsInstance = false;
	async get() {
		let count = 0;
		for await (const _r of tables.Doc.search({})) count++;
		return { count };
	}
}

// GET /Dump/ -> [{ id, bucket, seq }] every base row (the base-table oracle).
export class Dump extends Resource {
	static loadAsInstance = false;
	async get() {
		const out = [];
		for await (const r of tables.Doc.search({})) out.push({ id: r.id, bucket: r.bucket, seq: r.seq });
		return out;
	}
}
