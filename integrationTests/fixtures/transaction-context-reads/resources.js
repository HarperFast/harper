// Fixture for transaction-context-reads.test.ts.
//
// Each Dash* GET reads ScoreSnapshot rows for a company and reports how many it saw.
// All variants query the SAME seeded data; the only thing that varies is the
// transaction state of the ALS context at the moment ScoreSnapshot.search() runs —
// exercising the contract that a closed transaction reads latest committed state.
//
// `tables`, `databases`, `Resource`, `transaction` are Harper globals.

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

// POST-COMMIT ATOMICITY — commit the per-request transaction mid-handler, then write two records
// and throw. Those writes belong to the request transaction's pending final commit, so the failure
// must leave neither of them behind.
export class DashCommitWriteThrow extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const suffix = paramId(query) ?? 'x';
		await tables.Company.get('c1');
		await transaction.commit(this);
		await tables.Company.put({ id: `atomic-company-${suffix}`, name: 'should not survive' });
		await tables.ScoreSnapshot.put({ id: `atomic-snap-${suffix}`, companyId: 'atomic-co', score: 1 });
		throw new Error('deliberate failure after the mid-handler commit');
	}
}

// The same shape that succeeds: both post-commit writes must be durable once the request completes.
export class DashCommitWriteOk extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const suffix = paramId(query) ?? 'x';
		await tables.Company.get('c1');
		await transaction.commit(this);
		await tables.Company.put({ id: `ok-company-${suffix}`, name: 'kept' });
		await tables.ScoreSnapshot.put({ id: `ok-snap-${suffix}`, companyId: 'atomic-co', score: 2 });
		return { variant: 'commit-write-ok', suffix };
	}
}

// CLOSED-SLOT READ GUARD — the original point of this fixture, preserved now that an ordinary
// mid-handler commit rotates the scope to a fresh open generation instead of leaving it closed. An
// undrained iterator holds the native handle, so the commit cannot rotate and the slot stays genuinely
// CLOSED; the search that follows must still read the latest committed state rather than empty.
export class DashUndrainedThenSearch extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const companyId = paramId(query);
		const held = tables.ScoreSnapshot.search({
			conditions: [{ attribute: 'companyId', comparator: 'equals', value: companyId }],
		});
		const iterator = held[Symbol.asyncIterator]();
		await iterator.next(); // hold the handle open, do not drain
		const ctx = this.getContext();
		await transaction.commit(this);
		const txnOpenAfter = ctx?.transaction?.open;
		const snapshots = await searchSnapshots(companyId);
		return { variant: 'undrained-then-search', companyId, txnOpenAfter, count: snapshots.length, snapshots };
	}
}

// Drive the request context to a released slot holding an ImmediateTransaction: the request
// transaction closes under an undrained iterator (see DashUndrainedThenSearch), so the search that
// follows runs in a nested scope whose final commit defers releasing the context; draining that search
// completes the release mid-handler, and the instance load then puts an ImmediateTransaction in the
// emptied slot.
async function installImmediateTransactionOnReleasedSlot(resource) {
	const ctx = resource.getContext();
	const held = tables.ScoreSnapshot.search({
		conditions: [{ attribute: 'companyId', comparator: 'equals', value: 'atomic-co' }],
	});
	const holdIterator = held[Symbol.asyncIterator]();
	await holdIterator.next();
	await transaction.commit(resource);
	while (!(await holdIterator.next()).done);

	const nested = tables.ScoreSnapshot.search({
		conditions: [{ attribute: 'companyId', comparator: 'equals', value: 'atomic-co' }],
	});
	const nestedIterator = nested[Symbol.asyncIterator]();
	while (!(await nestedIterator.next()).done);

	await tables.Company.getResource('c1', ctx, {});
	return ctx?.transaction?.constructor?.name;
}

// RELEASED-SLOT WRITE — each write is its own static call, so each is its own scope and durable on its
// own (#2288).
export class DashReleasedSlotWrite extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const suffix = paramId(query) ?? 'x';
		const txnAfterInstall = await installImmediateTransactionOnReleasedSlot(this);
		await tables.Company.put({ id: `released-company-${suffix}`, name: 'kept' });
		await tables.ScoreSnapshot.put({ id: `released-snap-${suffix}`, companyId: 'atomic-co', score: 3 });
		return { variant: 'released-slot-write', suffix, txnAfterInstall };
	}
}

// RELEASED-SLOT EXPLICIT SCOPE — one scope over both writes, entered on the installed
// ImmediateTransaction: all-or-nothing (#2292).
export class DashReleasedSlotScopeThrow extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const suffix = paramId(query) ?? 'x';
		const ctx = this.getContext();
		const txnAfterInstall = await installImmediateTransactionOnReleasedSlot(this);
		let failed = false;
		try {
			await transaction(ctx, async () => {
				await tables.Company.put({ id: `scope-company-${suffix}`, name: 'should not survive' }, ctx);
				await tables.ScoreSnapshot.put({ id: `scope-snap-${suffix}`, companyId: 'atomic-co', score: 4 }, ctx);
				throw new Error('deliberate failure inside the explicit scope');
			});
		} catch {
			failed = true;
		}
		return { variant: 'released-slot-scope-throw', suffix, txnAfterInstall, failed };
	}
}

// The same scope that succeeds: both writes must be durable.
export class DashReleasedSlotScopeOk extends Resource {
	static loadAsInstance = false;
	async get(query) {
		const suffix = paramId(query) ?? 'x';
		const ctx = this.getContext();
		const txnAfterInstall = await installImmediateTransactionOnReleasedSlot(this);
		await transaction(ctx, async () => {
			await tables.Company.put({ id: `scope-ok-company-${suffix}`, name: 'kept' }, ctx);
			await tables.ScoreSnapshot.put({ id: `scope-ok-snap-${suffix}`, companyId: 'atomic-co', score: 5 }, ctx);
		});
		return { variant: 'released-slot-scope-ok', suffix, txnAfterInstall };
	}
}

// A second DATABASE reached through the installed ImmediateTransaction, written through the instance
// path so no wrapper opens a scope — this is the txnForContext chained link (#2292).
export class DashReleasedSlotChainedDatabase extends Resource {
	static loadAsInstance = false;
	async get() {
		const ctx = this.getContext();
		const txnAfterInstall = await installImmediateTransactionOnReleasedSlot(this);
		const note = await databases.second_db.AuditNote.getResource({ id: 'chained-note' }, ctx, {});
		note.update({ note: 'kept' }, false);
		await note.save();
		return { variant: 'released-slot-chained-database', txnAfterInstall };
	}
}

// A dispatched action that makes several writes — the dispatcher's join gate rather than transaction()'s.
export class MultiWriteAction extends Resource {
	static loadAsInstance = false;
	async get() {
		await tables.Company.put({ id: 'dispatched-company', name: 'should not survive' });
		await tables.ScoreSnapshot.put({ id: 'dispatched-snap', companyId: 'atomic-co', score: 6 });
		throw new Error('deliberate failure inside the dispatched action');
	}
}

export class DashReleasedSlotDispatch extends Resource {
	static loadAsInstance = false;
	async get() {
		const ctx = this.getContext();
		const txnAfterInstall = await installImmediateTransactionOnReleasedSlot(this);
		let failed = false;
		try {
			await MultiWriteAction.get('dispatched', ctx);
		} catch {
			failed = true;
		}
		return { variant: 'released-slot-dispatch', txnAfterInstall, failed };
	}
}
