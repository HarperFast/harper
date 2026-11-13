const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { waitFor } = require('../waitFor');

const DATABASE = 'source-txn-expiry';
const NOW = Date.now();
const HOUR = 3_600_000;
let serial = 0;

describe('a source-applied transaction gives each write only its own expiry', function () {
	this.timeout(10000);
	const subscriptions = [];

	before(() => setupTestDBPath());
	afterEach(async () => {
		for (const { release, done } of subscriptions.splice(0)) {
			release();
			await done;
		}
	});

	function newTable(tableOptions = {}, attributes = []) {
		return table({
			database: DATABASE,
			table: `TxnExpiry${++serial}`,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'v' }, ...attributes],
			audit: true,
			...tableOptions,
		});
	}

	function subscribe(Table, events) {
		let release;
		const held = new Promise((resolve) => (release = resolve));
		let finish;
		const done = new Promise((resolve) => (finish = resolve));
		subscriptions.push({ release, done });
		Table.sourcedFrom(
			{
				subscribeOnThisThread: () => true,
				async *subscribe() {
					try {
						yield* events;
						await held;
					} finally {
						finish();
					}
				},
			},
			{ intermediateSource: true }
		);
		return Table;
	}

	function put(id, timestamp, extra = {}, value = {}) {
		return { type: 'put', id, value: { id, ...value }, timestamp, version: timestamp, ...extra };
	}

	const entry = (Table, id) => Table.primaryStore.getEntry(id);
	const applied = (Table, ...ids) => waitFor(() => ids.every((id) => entry(Table, id)));
	const hasNoExpiry = (Table, id) =>
		assert.strictEqual(entry(Table, id).expiresAt, undefined, `${id} stored expiresAt ${entry(Table, id).expiresAt}`);

	it('does not give a write with no expiry the first write’s expiry', async () => {
		const firstExpiresAt = Date.now() + 300;
		const Table = subscribe(newTable(), [
			put('expiring', NOW + 0.1, { beginTxn: true, expiresAt: firstExpiresAt }),
			put('plain', NOW + 0.1),
			{ type: 'end_txn' },
		]);
		await applied(Table, 'expiring', 'plain');
		assert.equal(entry(Table, 'expiring').expiresAt, firstExpiresAt);
		hasNoExpiry(Table, 'plain');
		await waitFor(async () => (await Table.get('expiring')) == null, { timeout: 5000 });
		assert.equal((await Table.get('plain'))?.id, 'plain');
	});

	it('gives a write with no expiry the table default, not the first write’s expiry', async () => {
		const firstExpiresAt = Date.now() + 60_000;
		const before = Date.now();
		const Table = subscribe(newTable({ expiration: 3600 }), [
			put('expiring', NOW + 1.1, { beginTxn: true, expiresAt: firstExpiresAt }),
			put('defaulted', NOW + 1.1),
			put('unexpiring', NOW + 1.1, { expiresAt: -1 }),
			{ type: 'end_txn' },
		]);
		await applied(Table, 'expiring', 'defaulted', 'unexpiring');
		assert.equal(entry(Table, 'expiring').expiresAt, firstExpiresAt);
		const defaulted = entry(Table, 'defaulted').expiresAt;
		assert.ok(defaulted >= before + HOUR && defaulted <= Date.now() + HOUR, `defaulted stored expiresAt ${defaulted}`);
		hasNoExpiry(Table, 'unexpiring');
	});

	it('gives a write with no expiry its own @expiresAt field, for a put and for a patch', async () => {
		const fieldExpiresAt = Date.now() + 2 * HOUR;
		const patchedExpiresAt = Date.now() + 3 * HOUR;
		const firstExpiresAt = Date.now() + 60_000;
		const Table = subscribe(newTable({}, [{ name: 'expiresAt', expiresAt: true, indexed: true }]), [
			put('patched', NOW + 2.1, {}, { expiresAt: patchedExpiresAt }),
			put('expiring', NOW + 2.2, { beginTxn: true, expiresAt: firstExpiresAt }),
			put('fielded', NOW + 2.2, {}, { expiresAt: fieldExpiresAt }),
			{ type: 'patch', id: 'patched', value: { v: 2 }, timestamp: NOW + 2.2, version: NOW + 2.2 },
			{ type: 'end_txn' },
		]);
		await applied(Table, 'expiring', 'fielded');
		await waitFor(() => entry(Table, 'patched')?.value?.v === 2);
		assert.equal(entry(Table, 'expiring').expiresAt, firstExpiresAt);
		assert.equal(entry(Table, 'fielded').expiresAt, fieldExpiresAt);
		assert.equal(entry(Table, 'patched').expiresAt, patchedExpiresAt);
	});

	it('does not give a transaction wrapper’s expiry to a write in it', async () => {
		const Table = subscribe(newTable(), [
			{
				type: 'transaction',
				timestamp: NOW + 3.1,
				version: NOW + 3.1,
				expiresAt: Date.now() - 1,
				writes: [put('wrapped', NOW + 3.1)],
			},
		]);
		await applied(Table, 'wrapped');
		hasNoExpiry(Table, 'wrapped');
		assert.equal((await Table.get('wrapped'))?.id, 'wrapped');
	});

	it('keeps each write’s own expiry within one transaction', async () => {
		const firstExpiresAt = Date.now() + 60_000;
		const secondExpiresAt = Date.now() + 120_000;
		const Table = subscribe(newTable(), [
			put('first', NOW + 4.1, { beginTxn: true, expiresAt: firstExpiresAt }),
			put('second', NOW + 4.1, { expiresAt: secondExpiresAt }),
			{ type: 'end_txn' },
		]);
		await applied(Table, 'first', 'second');
		assert.equal(entry(Table, 'first').expiresAt, firstExpiresAt);
		assert.equal(entry(Table, 'second').expiresAt, secondExpiresAt);
	});

	it('still gives an ordinary write its context’s expiry', async () => {
		const Table = newTable();
		const contextExpiresAt = Date.now() + 60_000;
		await transaction({ expiresAt: contextExpiresAt }, () => Table.put('local', { id: 'local' }));
		assert.equal(entry(Table, 'local').expiresAt, contextExpiresAt);
	});
});
