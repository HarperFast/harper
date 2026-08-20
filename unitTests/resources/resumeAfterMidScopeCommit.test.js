const assert = require('assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');
const { DatabaseTransaction, TRANSACTION_STATE } = require('#src/resources/DatabaseTransaction');
const serverUtilities = require('#src/server/serverHelpers/serverUtilities');

// A handler that commits its own transaction mid-scope is a documented pattern, and its enclosing
// transaction() scope still has a final commit to make. The writes it makes after that commit
// therefore belong to that pending commit: they stage, and they roll back with it. Before this, each
// one committed immediately and individually, so a handler that failed halfway left the earlier half
// durable — which is how a failed cluster delete could mark a cluster TERMINATED with its instances
// still RUNNING.
// Runs on BOTH engines: LMDBTransaction already left a non-final commit OPEN (LMDBTransaction.ts's
// commit), so post-commit writes have always staged and rolled back with the scope there. This change
// brings the RocksDB path to that behavior. Four cases below are RocksDB-only, each for a stated
// engine reason — read-after-write, snapshot-free reads, and the two that reach into rocksdb-js.
const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';
const rocksOnly = isLMDB ? it.skip : it;

describe('Writes after a mid-scope commit rejoin the scope', () => {
	let A, B, Other;
	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		A = table({ table: 'ResumeA', attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }] });
		B = table({ table: 'ResumeB', attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }] });
		// A genuinely separate DATABASE, not just a second table: only this reaches txnForContext's
		// `transaction.next` chain, which is where a link created after the mid-scope commit could
		// otherwise be left committing on its own.
		Other = table({
			database: 'resume_other',
			table: 'ResumeOther',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }],
		});
	});

	async function scanValues(context) {
		const out = [];
		for await (const record of A.search([{ attribute: 'v', comparator: 'greater_than', value: -1 }], context))
			out.push(record.v);
		return out.sort((x, y) => x - y);
	}

	it('rolls post-commit writes back with the scope, across two stores', async function () {
		const context = {};
		await assert.rejects(
			transaction(context, async () => {
				await A.put('pre', { v: 1 }, context);
				await B.put('pre', { v: 1 }, context);
				await context.transaction.commit();
				await A.put('post', { v: 2 }, context);
				await B.put('post', { v: 2 }, context);
				throw new Error('forced failure after the mid-scope commit');
			}),
			/forced failure/
		);
		assert.ok(await A.get('pre'), 'what the explicit commit committed must stay committed');
		assert.ok(await B.get('pre'));
		assert.equal(await A.get('post'), undefined, 'a write made after the commit must roll back with the scope');
		assert.equal(await B.get('post'), undefined, 'including on a chained second store');
	});

	it('commits post-commit writes when the scope completes', async function () {
		const context = {};
		await transaction(context, async () => {
			await A.put('ok1', { v: 1 }, context);
			await context.transaction.commit();
			await A.put('ok2', { v: 2 }, context);
			await B.put('ok2', { v: 2 }, context);
			assert.equal(context.transaction.open, TRANSACTION_STATE.OPEN, 'the write must have reopened the scope');
		});
		for (const [t, id] of [
			[A, 'ok1'],
			[A, 'ok2'],
			[B, 'ok2'],
		])
			assert.ok(await t.get(id), `${id} must be durable once the scope commits`);
	});

	it('rolls back a post-commit write to a second DATABASE, through the chained link', async function () {
		const context = {};
		await assert.rejects(
			transaction(context, async () => {
				await A.put('chain-pre', { v: 1 }, context);
				await context.transaction.commit();
				await A.put('chain-post', { v: 2 }, context);
				await Other.put('chain-post', { v: 2 }, context); // creates transaction.next after the commit
				assert.ok(context.transaction.next, 'premise: a chained link must have been created');
				throw new Error('forced failure');
			}),
			/forced failure/
		);
		assert.ok(await A.get('chain-pre'));
		assert.equal(await A.get('chain-post'), undefined);
		assert.equal(await Other.get('chain-post'), undefined, 'the chained database must roll back too');
	});

	it('commits a post-commit write to a second DATABASE when the scope completes', async function () {
		const context = {};
		await transaction(context, async () => {
			await context.transaction.commit();
			await A.put('chain-ok', { v: 1 }, context);
			await Other.put('chain-ok', { v: 1 }, context);
		});
		assert.ok(await A.get('chain-ok'));
		assert.ok(await Other.get('chain-ok'), 'the chained database must be durable');
	});

	// A commit that FAILED leaves this generation finished and its durability unknown. Rotating after it
	// would let the rest of the scope stage into a generation whose predecessor may not have landed.
	// RocksDB only: forces a terminal failure through rocksdb-js's Transaction.
	rocksOnly('does not rotate after a failed mid-scope commit', async function () {
		const { Transaction } = require('@harperfast/rocksdb-js');
		const originalCommit = Transaction.prototype.commit;
		const targetDb = A.primaryStore.store.db;
		let forcedFailures = 0;
		const context = {};
		try {
			await transaction(context, async () => {
				await A.put('poison-seed', { v: 1 }, context);
				Transaction.prototype.commit = function (...args) {
					if (this.store?.db !== targetDb) return originalCommit.apply(this, args);
					forcedFailures++;
					Transaction.prototype.commit = originalCommit; // one forced failure only
					return Promise.reject(Object.assign(new Error('forced terminal failure'), { code: 'ERR_CORRUPTION' }));
				};
				await assert.rejects(context.transaction.commit(), /forced terminal failure/);
				assert.notEqual(
					context.transaction?.open,
					TRANSACTION_STATE.OPEN,
					'a failed commit must not leave an open generation behind'
				);
				await A.put('after-failed-commit', { v: 2 }, context);
			});
		} finally {
			Transaction.prototype.commit = originalCommit;
		}
		assert.ok(forcedFailures > 0, 'premise: the explicit commit must actually have failed');
		assert.equal(await A.get('poison-seed'), undefined, 'the failed commit committed nothing');
		assert.ok(
			await A.get('after-failed-commit'),
			'a write after a failed commit must commit itself rather than stage into a generation nobody will commit'
		);
	});

	// RocksDB only: LMDB does not guarantee read-after-write within a transaction.
	rocksOnly('reads its own post-commit writes', async function () {
		const context = {};
		await transaction(context, async () => {
			await context.transaction.commit();
			await A.put('own', { v: 7 }, context);
			assert.equal((await A.get('own', context))?.v, 7);
		});
	});

	// Committing mid-handler is documented as the way to stop reading a pinned snapshot, so every read
	// shape has to keep seeing other writers for the rest of the scope — including a search() iterator,
	// which holds its own handle. This is what the resumed transaction's snapshot-free mode buys.
	// RocksDB only: only RocksDB can open a snapshot-free read transaction; LMDB keeps its snapshot.
	rocksOnly('keeps reads seeing other writers for the rest of the scope', async function () {
		await A.put('shared', { v: 1 }, {});
		const context = {};
		const pointReads = [];
		await transaction(context, async () => {
			await A.get('shared', context);
			await context.transaction.commit();
			for (let v = 2; v <= 4; v++) {
				await A.put('shared', { v }, {}); // another writer: its OWN context, not the ambient one
				pointReads.push((await A.get('shared', context)).v);
				pointReads.push((await transaction(() => A.get('shared'))).v); // the migration-guide form
			}
			await A.put('own-write', { v: 50 }, context); // resume the scope, then keep reading
			const before = await scanValues(context);
			await A.put('scan-visible', { v: 99 }, {}); // another writer again
			const after = await scanValues(context);
			assert.ok(
				after.includes(99) && !before.includes(99),
				'a search() after the commit must still pick up another writer’s row'
			);
		});
		assert.deepEqual(pointReads, [2, 2, 3, 3, 4, 4], 'every read after the commit must see the latest value');
	});

	// The gate is ownership, not state — and the case it exists for is a DatabaseTransaction sitting OPEN
	// in a context that no transaction() scope owns: crash-recovery replay (replayLogs.ts) commits in a
	// loop at timestamp boundaries, and Table.ts builds one directly. If the gate regressed to "anything
	// rotates", replay would stage its post-commit writes into a generation its loop never commits. The
	// released-slot test below cannot see that: it goes through the placeholder, so txnForContext builds
	// an ImmediateTransaction and never consults ownership at all.
	rocksOnly('does not rotate a transaction no scope owns', async function () {
		const context = { transaction: new DatabaseTransaction() };
		await A.put('unowned-1', { v: 1 }, context);
		assert.ok(context.transaction, 'premise: the unowned transaction is still the context’s');
		await context.transaction.commit();
		assert.notEqual(
			context.transaction.open,
			TRANSACTION_STATE.OPEN,
			'an unowned transaction must stay closed after its own commit — nothing guarantees another commit'
		);
		await A.put('unowned-2', { v: 2 }, context);
		assert.ok(await A.get('unowned-1'));
		assert.ok(
			await A.get('unowned-2'),
			'a write after an unowned transaction’s commit must commit itself, not stage into a generation nobody commits'
		);
	});

	it('does not resume a transaction with no owning scope', async function () {
		const context = {};
		await transaction(context, async () => {
			await A.put('scoped', { v: 1 }, context);
		});
		// The scope is over. These writes have no pending commit and must be durable on their own.
		await A.put('after-scope-1', { v: 1 }, context);
		await A.put('after-scope-2', { v: 2 }, context);
		assert.ok(await A.get('after-scope-1'), 'a write after the scope ended must commit itself');
		assert.ok(await A.get('after-scope-2'));
	});

	// A read between the commit and the writes must not quietly cost the guarantee. Committing
	// mid-handler in order to re-read is the documented reason to commit at all, so if an intervening
	// read dropped the scope's transaction from the context the guarantee would be absent in exactly
	// the shape people use.
	it('keeps post-commit writes atomic even when a read comes between', async function () {
		const context = {};
		await assert.rejects(
			transaction(context, async () => {
				await A.put('seed', { v: 0 }, context);
				await context.transaction.commit();
				await A.get('seed', context);
				await scanValues(context);
				await A.put('after-read', { v: 1 }, context);
				throw new Error('forced failure');
			}),
			/forced failure/
		);
		assert.equal(await A.get('after-read'), undefined, 'the write after an intervening read must roll back too');
	});

	// The one shape the guarantee does NOT cover, pinned so it cannot change silently: with an iterator
	// still holding the native handle at commit time, that handle belongs to the iterator until it
	// drains, so there is nothing to rotate into and the writes keep committing individually. This is
	// the checkpoint-over-a-search loop, and it is stated on Context.transaction for that reason.
	// RocksDB only: the retained-handle branch is the RocksDB commit path.
	rocksOnly('does not rotate while an iterator still holds the handle, and says so', async function () {
		await A.put('iter-seed', { v: 1 }, {});
		const context = {};
		let openState;
		await transaction(context, async () => {
			const results = await A.search([{ attribute: 'v', comparator: 'greater_than', value: -1 }], context);
			const iterator = results[Symbol.asyncIterator]();
			await iterator.next(); // hold the handle open
			await A.put('iter-write', { v: 2 }, context);
			await context.transaction.commit();
			openState = context.transaction.open;
			await A.put('iter-post', { v: 3 }, context);
			while (!(await iterator.next()).done);
		});
		assert.notEqual(openState, TRANSACTION_STATE.OPEN, 'a retained handle must block the rotation');
		assert.ok(
			await A.get('iter-post'),
			'and the write after that commit therefore commits on its own — the documented carve-out'
		);
	});

	it('still lets a checkpoint loop commit repeatedly inside one scope', async function () {
		const context = {};
		await transaction(context, async () => {
			for (let i = 0; i < 4; i++) {
				await A.put(`ckpt-${i}`, { v: i }, context);
				await transaction.commit(context);
			}
		});
		for (let i = 0; i < 4; i++) assert.ok(await A.get(`ckpt-${i}`), `ckpt-${i} must persist`);
	});

	it('resumes under an ambient operation-handler context too', async function () {
		await serverUtilities.processLocalTransaction(
			{ body: { operation: 'test_registered_op', hdb_user: { username: 'internal_bookkeeping' } } },
			async () => {
				await A.put('ambient', { v: 1 });
				return { message: 'ok' };
			}
		);
		assert.ok(await A.get('ambient'), 'the ambient path must be unaffected');
	});
});
