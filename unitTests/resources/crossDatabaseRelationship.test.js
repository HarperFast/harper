const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setTxnExpiration } = require('#src/resources/DatabaseTransaction');
const { setTimeout: delay } = require('node:timers/promises');
const { getWorkerIndex, setMainIsWorker } = require('#js/server/threads/manageThreads');

// A join into another database reads that database's indexes through its own link in the request's
// transaction chain, lazily, after the request commits (REST serializes after commit). The search must
// hold that link's read handle until its results are done, and give it back on every way they end.
describe('cross-database relationship search', function () {
	let Emp, Badge, previousMainIsWorker;
	const GOLD_IDS = Array.from({ length: 10 }, (_, i) => `e${i * 2}`).sort();

	before(async function () {
		setupTestDBPath();
		previousMainIsWorker = getWorkerIndex() === 0;
		setMainIsWorker(true);
		Badge = table({
			database: 'xdb_rel_hr',
			table: 'Badge',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'label', indexed: true },
			],
		});
		Emp = table({
			database: 'xdb_rel_data',
			table: 'Emp',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'badgeIds', indexed: true, elements: { type: 'ID' } },
				{
					name: 'badges',
					elements: { type: 'Badge', definition: { tableClass: Badge } },
					relationship: { from: 'badgeIds' },
				},
			],
		});
		await Badge.put({ id: 'b1', label: 'gold' });
		await Badge.put({ id: 'b2', label: 'silver' });
		for (let i = 0; i < 20; i++) await Emp.put({ id: `e${i}`, badgeIds: i % 2 ? ['b2'] : ['b1', 'b2'] });
	});

	after(function () {
		setMainIsWorker(previousMainIsWorker);
	});

	async function searchAfterCommit() {
		const context = {};
		let badgeLink, empLink;
		const results = await transaction(context, () => {
			const results = Emp.search({ conditions: [{ attribute: ['badges', 'label'], value: 'gold' }] }, context);
			badgeLink = Badge._txnForContext(context);
			empLink = Emp._txnForContext(context);
			return results;
		});
		assert.notStrictEqual(badgeLink, empLink, 'the related table must read through its own database link');
		return { results, badgeLink, empLink };
	}

	it('reads the related database after commit and releases its handle when exhausted', async function () {
		const { results, badgeLink } = await searchAfterCommit();
		assert.strictEqual(badgeLink.readTxnsUsed, 1, 'the related handle must survive the commit');
		const ids = [];
		for await (const entry of results) ids.push(entry.id);
		assert.deepStrictEqual(ids.sort(), GOLD_IDS);
		assert.strictEqual(badgeLink.readTxnsUsed, 0);
	});

	it('releases the related handle on early return', async function () {
		const { results, badgeLink } = await searchAfterCommit();
		for await (const _entry of results) break;
		assert.strictEqual(badgeLink.readTxnsUsed, 0);
	});

	it('releases the related handle when the transaction closes abandoned results', async function () {
		const { badgeLink } = await searchAfterCommit();
		assert.strictEqual(badgeLink.readTxnsUsed, 1);
		badgeLink.closeOwnedReadIterators();
		assert.strictEqual(badgeLink.readTxnsUsed, 0);
	});

	it('keeps streaming while a drained related link sits through monitor ticks', async function () {
		setTxnExpiration(20);
		try {
			const { results, badgeLink, empLink } = await searchAfterCommit();
			const ids = [];
			const deadline = Date.now() + 10_000;
			for await (const entry of results) {
				ids.push(entry.id);
				// let a monitor tick consume the source's activity before reading on, so the source stays live
				// while the related link, whose index the join drained up front, sees none of its own
				while (empLink.rangeReadActive && Date.now() < deadline) await delay(5);
			}
			assert.deepStrictEqual(ids.sort(), GOLD_IDS);
			assert.strictEqual(badgeLink.readTxnsUsed, 0);
		} finally {
			setTxnExpiration(30000);
		}
	});

	it('keeps the related lease while the source scans without emitting rows', async function () {
		// LMDB read snapshots are reference-counted and its monitor tracks no range activity
		if (Emp.primaryStore.path?.endsWith('.mdb')) this.skip();
		setTxnExpiration(20);
		try {
			const { results, badgeLink, empLink } = await searchAfterCommit();
			// the source keeps scanning (filtered or sorted rows, no output) across several monitor ticks,
			// while nothing touches the related link
			const deadline = Date.now() + 10_000;
			for (let ticks = 0; ticks < 5 && Date.now() < deadline;) {
				empLink.rangeReadActive = true;
				while (empLink.rangeReadActive && Date.now() < deadline) await delay(5);
				ticks++;
			}
			assert.strictEqual(
				badgeLink.readTxnsUsed,
				1,
				'the related lease must outlive idle ticks while its holder is live'
			);
			const ids = [];
			for await (const entry of results) ids.push(entry.id);
			assert.deepStrictEqual(ids.sort(), GOLD_IDS);
			assert.strictEqual(badgeLink.readTxnsUsed, 0);
		} finally {
			setTxnExpiration(30000);
		}
	});

	it('opens no read handle on a related database first read after the request committed', async function () {
		// the context is released at commit, so a resolver read after it must take a handle-free transaction
		const context = {};
		let root;
		const results = await transaction(context, (transaction) => {
			root = transaction;
			return Emp.search({ select: ['id', { name: 'badges', select: ['label'] }], limit: 3 }, context);
		});
		const rows = [];
		for await (const row of results) rows.push(row);
		assert.strictEqual(rows.length, 3);
		assert.ok(rows.every((row) => row.badges.length > 0));
		let badgeLinks = 0;
		for (const head of new Set([root, context.transaction])) {
			for (let link = head; link; link = link.next) {
				if (link.db !== Badge.primaryStore) continue;
				badgeLinks++;
				assert.ok(!link.readTxn && !link.transaction, 'a link joined after commit must not hold a reader');
			}
		}
		assert.ok(badgeLinks > 0, 'the resolver read must have joined the request');
	});
});
