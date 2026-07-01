// QA-185 — Within-request read-snapshot contract.
//
// Characterises whether a SINGLE Harper response presents a self-consistent snapshot
// across REST, GraphQL, ops search_by_val, SQL SELECT, and a custom multi-key resource.
//
// Endpoints:
//
//   POST /SeedLedger/    { bucket, count, val }
//       Inserts `count` rows: id=`${bucket}-${pad(i)}`, bucket, seq=i, val=val.
//
//   POST /SeedAccount/   { n, each }
//       Inserts n accounts `acct-0`..`acct-${n-1}` each with balance=each.
//
//   POST /TransferAccount/ { from, to, amount }
//       Plain read-modify-write: reads both balances in this request txn, then writes
//       absolute new vals via .set(). Deterministic acquisition order to avoid deadlock.
//
//   GET  /LedgerSnap/?bucket=<b>
//       Within ONE request transaction: scans Ledger for bucket, returns
//       { bucket, count, minSeq, maxSeq, vals: [...] }.
//       If every `val` in the array equals the seeded constant, the response is
//       self-consistent (no torn-val mid-scan write visible).
//
//   GET  /AccountPairSnap/?a=<id>&b=<id>
//       Within ONE request transaction reads BOTH accounts via get(), returns
//       { a, b, ba, bb, sum }. sum != constant => within-request snapshot tear.
//
//   GET  /AccountScan/
//       Within ONE request transaction, full Ledger scan of all Accounts, returns { sum, n }.
//
//   POST /LedgerMutate/ { bucket, count }
//       Rapidly inserts then deletes `count` rows within one request — simulates churn
//       that runs concurrently with the readers.
//
//   GET  /Probe/
//       Readiness probe. Returns { ok: true }.

function pad(n) {
	return String(n).padStart(6, '0');
}

// POST /SeedLedger/ { bucket, count, val }
export class SeedLedger extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const bucket = b.bucket || 'B';
		const count = Number(b.count) || 0;
		const val = Number(b.val) || 0;
		for (let i = 0; i < count; i++) {
			await tables.Ledger.put({ id: `${bucket}-${pad(i)}`, bucket, seq: i, val });
		}
		return { ok: true, bucket, count, val };
	}
}

// POST /SeedAccount/ { n, each }
export class SeedAccount extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const n = Number(b.n) || 0;
		const each = Number(b.each) || 0;
		for (let i = 0; i < n; i++) {
			await tables.Account.put({ id: `acct-${i}`, balance: each });
		}
		return { ok: true, n, each, total: n * each };
	}
}

// POST /TransferAccount/ { from, to, amount }
// Plain read-modify-write in ONE request transaction. Deterministic lock order (sorted by id)
// to avoid deadlock. Returns { ok, from, to, amount }.
export class TransferAccount extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const from = b.from;
		const to = b.to;
		const amount = Number(b.amount) || 0;
		// Deterministic acquisition order
		const [first, second] = from < to ? [from, to] : [to, from];
		const rFirst = await tables.Account.get(first);
		const rSecond = await tables.Account.get(second);
		const balFirst = (rFirst && rFirst.balance) || 0;
		const balSecond = (rSecond && rSecond.balance) || 0;
		const uFirst = await tables.Account.update(first, {});
		uFirst.set('id', first);
		const uSecond = await tables.Account.update(second, {});
		uSecond.set('id', second);
		if (from < to) {
			// first === from (debit), second === to (credit)
			uFirst.set('balance', balFirst - amount);
			uSecond.set('balance', balSecond + amount);
		} else {
			// first === to (credit), second === from (debit)
			uFirst.set('balance', balFirst + amount);
			uSecond.set('balance', balSecond - amount);
		}
		return { ok: true, from, to, amount };
	}
}

// GET /LedgerSnap/?bucket=<b>
// Within ONE request transaction: scans Ledger for the given bucket via indexed search,
// then returns a summary. If the scan holds a stable snapshot, every `val` in the
// returned array will equal the seeded constant (a mid-scan overwrite with a different
// val would produce an inconsistent val entry).
export class LedgerSnap extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const bucket = (query && (query.get ? query.get('bucket') : query.bucket)) || 'B';
		const rows = [];
		for await (const r of tables.Ledger.search([{ attribute: 'bucket', value: bucket }])) {
			rows.push({ seq: r.seq, val: r.val });
		}
		const count = rows.length;
		const vals = rows.map((r) => r.val);
		const seqs = rows.map((r) => r.seq);
		const minSeq = seqs.length ? Math.min(...seqs) : null;
		const maxSeq = seqs.length ? Math.max(...seqs) : null;
		return { bucket, count, minSeq, maxSeq, vals };
	}
}

// GET /AccountPairSnap/?a=<id>&b=<id>
// Within ONE request transaction reads BOTH accounts via two get() calls.
// sum != constant => within-request snapshot tear (F-029 single-request cross-check).
export class AccountPairSnap extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const a = (query && (query.get ? query.get('a') : query.a)) || '';
		const b = (query && (query.get ? query.get('b') : query.b)) || '';
		const ra = await tables.Account.get(a);
		const rb = await tables.Account.get(b);
		const ba = (ra && ra.balance) || 0;
		const bb = (rb && rb.balance) || 0;
		return { a, b, ba, bb, sum: ba + bb };
	}
}

// GET /AccountScan/
// Full scan of all Account rows in ONE request transaction. Returns { sum, n }.
export class AccountScan extends Resource {
	static loadAsInstance = false;
	async get() {
		let sum = 0;
		let n = 0;
		for await (const rec of tables.Account.search({})) {
			sum += Number(rec.balance) || 0;
			n++;
		}
		return { sum, n };
	}
}

// POST /LedgerMutate/ { bucket, count }
// Inserts `count` rows then deletes them, all within ONE request transaction.
// Simulates churn running concurrently with readers, to stress read-snapshot stability.
export class LedgerMutate extends Resource {
	static loadAsInstance = false;
	async post(query, body) {
		const b = body || query || {};
		const bucket = b.bucket || 'B';
		const count = Number(b.count) || 0;
		// Insert with a distinct val (99) to distinguish from the seeded val (1 or 42)
		const mutValue = 99;
		for (let i = 0; i < count; i++) {
			await tables.Ledger.put({ id: `${bucket}-mut-${pad(i)}`, bucket, seq: 10000 + i, val: mutValue });
		}
		for (let i = 0; i < count; i++) {
			try {
				await tables.Ledger.delete(`${bucket}-mut-${pad(i)}`);
			} catch {
				/* already gone */
			}
		}
		return { ok: true, bucket, count, mutValue };
	}
}

// GET /Probe/
// Readiness probe — returns { ok: true } once HTTP workers are up.
export class Probe extends Resource {
	static loadAsInstance = false;
	async get() {
		return { ok: true };
	}
}
