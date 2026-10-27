const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { setTxnExpiration } = require('#src/resources/DatabaseTransaction');
const { setTxnExpiration: setLMDBTxnExpiration } = require('#src/resources/LMDBTransaction');
const { setTimeout: delay } = require('node:timers/promises');
const { getWorkerIndex, setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('cross-database relationship search', function () {
	let Emp, Badge, Org, Vault, Staff, previousMainIsWorker;
	const GOLD_IDS = Array.from({ length: 10 }, (_, i) => `e${i * 2}`).sort();
	const VAULTS = 10_000;

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
		Org = table({
			database: 'xdb_rel_org',
			table: 'Org',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		Vault = table({
			database: 'xdb_rel_hr',
			table: 'Vault',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'orgId', indexed: true },
				{ name: 'org', type: 'Org', relationship: { from: 'orgId' }, definition: { tableClass: Org } },
			],
		});
		Staff = table({
			database: 'xdb_rel_data',
			table: 'Staff',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'vaultId', indexed: true },
				{ name: 'vault', type: 'Vault', relationship: { from: 'vaultId' }, definition: { tableClass: Vault } },
			],
		});
		// many vault names a contains-filter rejects, each yielding an event turn, scanned before the one it
		// matches (RocksDB only: the monitor case it feeds does not run on LMDB)
		if (!Emp.primaryStore.path?.endsWith('.mdb')) {
			await transaction({}, () => {
				const puts = [];
				for (let i = 0; i < VAULTS; i++) {
					const name = `name-${String(i).padStart(5, '0')}`;
					puts.push(Vault.put({ id: `v${i}`, name }), Org.put({ id: `o${i}`, name }));
				}
				return Promise.all(puts);
			});
		}
		await Org.put({ id: 'oAlpha', name: 'zz-Alpha' });
		await Vault.put({ id: 'vAlpha', name: 'zz-Alpha', orgId: 'oAlpha' });
		await Staff.put({ id: 's1', vaultId: 'vAlpha' });
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

	it('releases each handle when its link closes abandoned reads', async function () {
		const { badgeLink, empLink } = await searchAfterCommit();
		assert.strictEqual(badgeLink.readTxnsUsed, 1);
		badgeLink.closeOwnedReadIterators();
		assert.strictEqual(badgeLink.readTxnsUsed, 0);
		empLink.closeOwnedReadIterators();
		assert.strictEqual(empLink.readTxnsUsed, 0);
	});

	it('keeps streaming while a drained related link sits through monitor ticks', async function () {
		setTxnExpiration(20);
		setLMDBTxnExpiration(20);
		try {
			const { results, badgeLink, empLink } = await searchAfterCommit();
			const ids = [];
			const deadline = Date.now() + 10_000;
			const isLmdb = Emp.primaryStore.path?.endsWith('.mdb');
			for await (const entry of results) {
				ids.push(entry.id);
				// let a monitor tick consume the source's activity before reading on, so the source stays live
				// while the related link, whose index the join drained up front, sees none of its own (LMDB
				// tracks no range activity, so pause past a tick instead)
				if (isLmdb) await delay(30);
				else while (empLink.rangeReadActive && Date.now() < deadline) await delay(5);
			}
			assert.deepStrictEqual(ids.sort(), GOLD_IDS);
			assert.strictEqual(badgeLink.readTxnsUsed, 0);
		} finally {
			setTxnExpiration(30000);
			setLMDBTxnExpiration(30000);
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

	it('reaps two abandoned leases held in opposite directions', async function () {
		if (Emp.primaryStore.path?.endsWith('.mdb')) this.skip();
		setTxnExpiration(20);
		try {
			const context = {};
			let empLink, badgeLink, empLease, badgeLease;
			await transaction(context, () => {
				empLink = Emp._txnForContext(context);
				badgeLink = Badge._txnForContext(context);
				badgeLease = badgeLink.leaseReadTxn(empLink);
				empLease = empLink.leaseReadTxn(badgeLink);
			});
			assert.ok(badgeLease.readTxn && empLease.readTxn, 'each lease must hold a native handle');
			const deadline = Date.now() + 10_000;
			while ((badgeLease.onDone || empLease.onDone) && Date.now() < deadline) await delay(10);
			assert.strictEqual(badgeLease.onDone, null, 'an idle lease must be reaped even though its holder holds one too');
			assert.strictEqual(empLease.onDone, null);
			assert.strictEqual(badgeLink.readTxnsUsed, 0);
			assert.strictEqual(empLink.readTxnsUsed, 0);
		} finally {
			setTxnExpiration(30000);
		}
	});

	it('keeps the source handle while a filtered related scan yields across monitor ticks', async function () {
		if (Emp.primaryStore.path?.endsWith('.mdb')) this.skip();
		setTxnExpiration(2);
		try {
			const context = {};
			const results = await transaction(context, () =>
				Staff.search(
					{
						conditions: [{ attribute: ['vault', 'name'], comparator: 'contains', value: 'Alpha' }],
						allowFullScan: true,
					},
					context
				)
			);
			const started = performance.now();
			const ids = [];
			for await (const entry of results) ids.push(entry.id);
			assert.ok(performance.now() - started > 10, 'the related scan must span several monitor ticks');
			assert.deepStrictEqual(ids, ['s1']);
		} finally {
			setTxnExpiration(30000);
		}
	});

	it('keeps a related lease for a holder the monitor does not walk', async function () {
		if (Emp.primaryStore.path?.endsWith('.mdb')) this.skip();
		const trackedTxns = setTxnExpiration(20);
		try {
			const { results, badgeLink, empLink } = await searchAfterCommit();
			// as for a link whose handle save() adopted: never walked, so only its lease partner can consume its flag
			trackedTxns.delete(empLink);
			const deadline = Date.now() + 10_000;
			for (let ticks = 0; ticks < 5 && Date.now() < deadline;) {
				empLink.rangeReadActive = true;
				while (empLink.rangeReadActive && Date.now() < deadline) await delay(5);
				ticks++;
			}
			assert.strictEqual(badgeLink.readTxnsUsed, 1, 'a scanning holder keeps its lease even when untracked');
			const ids = [];
			for await (const entry of results) ids.push(entry.id);
			assert.deepStrictEqual(ids.sort(), GOLD_IDS);
		} finally {
			setTxnExpiration(30000);
		}
	});

	it('keeps an intermediate hop of a multi-hop join while the last hop scans', async function () {
		if (Emp.primaryStore.path?.endsWith('.mdb')) this.skip();
		setTxnExpiration(2);
		try {
			const context = {};
			const results = await transaction(context, () =>
				Staff.search(
					{
						conditions: [{ attribute: ['vault', 'org', 'name'], comparator: 'contains', value: 'Alpha' }],
						allowFullScan: true,
					},
					context
				)
			);
			const started = performance.now();
			const ids = [];
			for await (const entry of results) ids.push(entry.id);
			assert.ok(performance.now() - started > 10, 'the last hop must scan across several monitor ticks');
			assert.deepStrictEqual(ids, ['s1']);
		} finally {
			setTxnExpiration(30000);
		}
	});
});
