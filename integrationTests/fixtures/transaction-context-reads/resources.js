// Fixture for transaction-context-reads.test.ts.
//
// Each Dash* GET reads ScoreSnapshot rows for a company and reports how many it saw.
// All variants query the SAME seeded data; the only thing that varies is the
// transaction state of the ALS context at the moment ScoreSnapshot.search() runs —
// exercising the contract that a closed transaction reads latest committed state.
//
// `tables`, `Resource`, `transaction` are Harper globals.

function paramId(query) {
	return query && query.get ? (query.get('company') ?? query.company) : query && query.company;
}

async function searchSnapshots(companyId) {
	const out = [];
	for await (const rec of tables.ScoreSnapshot.search({
		conditions: [{ attribute: 'companyId', comparator: 'equals', value: companyId }],
	})) {
		out.push(rec.id);
	}
	out.sort();
	return out;
}

// CONTROL — ScoreSnapshot.search is the FIRST table op in the request, so no closed
// transaction exists in the ALS context yet.
export class DashControl extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const companyId = paramId(query);
		const snapshots = await searchSnapshots(companyId);
		return { variant: 'control', companyId, count: snapshots.length, snapshots };
	}
}

// NORMAL — Company.get() then ScoreSnapshot.search(), both inside the single OPEN
// per-request transaction (REST wraps the handler in transaction(request, ...)).
export class DashGetThenSearch extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const companyId = paramId(query);
		const company = await tables.Company.get(companyId);
		const snapshots = await searchSnapshots(companyId);
		return { variant: 'get-then-search', companyId, company: company?.id ?? null, count: snapshots.length, snapshots };
	}
}

// FORCED-CLOSED — read Company, then explicitly COMMIT the per-request transaction
// (closing it but leaving the closed DatabaseTransaction on context.transaction in
// ALS), THEN run ScoreSnapshot.search(). The closed slot must still read latest.
export class DashCommitThenSearch extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const companyId = paramId(query);
		const company = await tables.Company.get(companyId);
		const ctx = this.getContext();
		const stateBefore = ctx?.transaction?.open;
		await transaction.commit(this); // commit + close the request txn; it stays in ALS
		const stateAfter = ctx?.transaction?.open;
		const snapshots = await searchSnapshots(companyId);
		return {
			variant: 'commit-then-search',
			companyId,
			company: company?.id ?? null,
			txnOpenBefore: stateBefore,
			txnOpenAfter: stateAfter,
			count: snapshots.length,
			snapshots,
		};
	}
}

// LAZY-ITERABLE — Company.get() first, then RETURN the ScoreSnapshot.search() iterable
// without consuming it. REST awaits the handler return, commits the request txn, THEN
// serializes the response by iterating — so the iteration happens against a committed/
// closed transaction. This is the most realistic "dashboard returns a query" pattern.
export class DashLazyIterable extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const companyId = paramId(query);
		await tables.Company.get(companyId); // first op opens/uses the request txn
		return tables.ScoreSnapshot.search({
			conditions: [{ attribute: 'companyId', comparator: 'equals', value: companyId }],
		});
	}
}

// FORCED-CLOSED via a write — same as above but the first op is a write whose commit
// closes the txn, closer to a real handler that writes then reads.
export class DashWriteThenSearch extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const companyId = paramId(query);
		await tables.Company.put({ id: companyId, name: 'touched' });
		await transaction.commit(this);
		const snapshots = await searchSnapshots(companyId);
		return { variant: 'write-then-search', companyId, count: snapshots.length, snapshots };
	}
}
