const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { waitFor } = require('../waitFor.js');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const { DatabaseTransaction, setTxnExpiration } = require('#src/resources/DatabaseTransaction');
const { transaction } = require('#src/resources/transaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

describe('RocksDB range read activity', function () {
	let Rows;
	const opened = [];
	before(async function () {
		if (isLMDB) this.skip();
		setupTestDBPath();
		setMainIsWorker(true);
		Rows = table({
			database: 'rangeActivity',
			table: 'Rows',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'bucket', indexed: true },
			],
		});
		if (Rows.indexingOperation) await Rows.indexingOperation;
		for (let id = 0; id < 20; id++) await Rows.put({ id, bucket: 'before' });
	});
	afterEach(function () {
		setTxnExpiration(30000);
		for (const txn of opened.splice(0)) txn.abort();
	});

	function openRead() {
		const txn = new DatabaseTransaction();
		txn.db = Rows.primaryStore;
		opened.push(txn);
		const native = txn.useReadTxn();
		return { txn, native };
	}

	for (const kind of ['primary', 'index']) {
		function range(native) {
			return (kind === 'primary' ? Rows.primaryStore : Rows.indices.bucket).getRange({ transaction: native });
		}

		it(`${kind}: retains a committed snapshot while the scan crosses monitor ticks`, async function () {
			setTxnExpiration(20);
			const { txn, native } = openRead();
			const iterator = range(native)[Symbol.iterator]();
			await txn.commit();
			let count = 0;
			while (!iterator.next().done) {
				count++;
				await waitFor(() => !txn.rangeReadActive, { interval: 1 });
				assert.strictEqual(txn.transaction, native, 'progress must retain the original snapshot');
			}
			assert.equal(count, 20);
			txn.doneReadTxn();
			assert.equal(txn.transaction, null);
		});

		it(`${kind}: counts progress even when every row is filtered out`, async function () {
			setTxnExpiration(20);
			const { txn, native } = openRead();
			const filtered = range(native).filter(async () => {
				await waitFor(() => !txn.rangeReadActive, { interval: 1 });
				assert.strictEqual(txn.transaction, native);
				return false;
			});
			await txn.commit();
			let count = 0;
			for await (const _entry of filtered) count++;
			assert.equal(count, 0);
			txn.doneReadTxn();
			assert.equal(txn.transaction, null);
		});

		for (const started of [false, true]) {
			it(`${kind}: reports expired ${started ? 'started' : 'unstarted'} scans before native access`, async function () {
				setTxnExpiration(10);
				const { txn, native } = openRead();
				const iterator = range(native)[Symbol.iterator]();
				if (started) assert.notEqual(iterator.next().done, true);
				await txn.commit();
				await waitFor(() => txn.transaction === null, { interval: 1 });
				const expired = (error) => error.statusCode === 503 && error.name === 'ReadSnapshotExpiredError';
				assert.throws(() => iterator.next(), expired);
				assert.throws(() => range(native), expired);
				assert.equal(iterator.return().done, true);
				assert.equal(iterator.return().done, true);
				assert.equal(iterator.next().done, true);
			});
		}

		it(`${kind}: closing or throwing early does not retain an iterator reference`, async function () {
			for (const throws of [false, true]) {
				const { txn, native } = openRead();
				const iterator = range(native)[Symbol.iterator]();
				iterator.next();
				await txn.commit();
				if (throws) {
					const error = new Error('consumer failed');
					assert.throws(
						() => iterator.throw(error),
						(caught) => caught === error
					);
				} else iterator.return();
				txn.doneReadTxn();
				assert.equal(txn.transaction, null);
				assert.equal(iterator.return().done, true);
			}
		});
	}

	it('Table.search releases the retained snapshot on early consumer return', async function () {
		const context = {};
		await transaction(context, async (txn) => {
			const results = Rows.search({}, context);
			await txn.commit();
			assert.ok(txn.transaction);
			for await (const _row of results) break;
			assert.equal(txn.transaction, null);
		});
	});

	it('keeps primary and index reads on the original snapshot after another request commits', async function () {
		const { native } = openRead();
		const primary = Rows.primaryStore.getRange({ transaction: native });
		const index = Rows.indices.bucket.getRange({
			transaction: native,
			start: 'before',
			end: 'before',
			inclusiveEnd: true,
		});
		await Rows.put({ id: 19, bucket: 'after' });
		try {
			assert.equal([...primary].find(({ key }) => key === 19).value.bucket, 'before');
			assert.ok([...index].some(({ value }) => value === 19));
		} finally {
			await Rows.put({ id: 19, bucket: 'before' });
		}
	});

	it('preserves read-your-writes through primary and index searches', async function () {
		const context = {};
		await transaction(context, async () => {
			await Rows.put({ id: 100, bucket: 'own' }, context);
			for (const conditions of [[], [{ attribute: 'bucket', value: 'own' }]]) {
				const ids = [];
				for await (const row of Rows.search({ conditions }, context)) ids.push(row.id);
				assert.ok(ids.includes(100));
			}
		});
		await Rows.delete(100);
	});

	it('range activity cannot extend an idle write holder and its write is rolled back', async function () {
		setTxnExpiration(20);
		const context = {};
		await assert.rejects(
			transaction(context, async (txn) => {
				await Rows.put({ id: 101, bucket: 'uncommitted' }, context);
				const native = Rows._readTxnForContext(context);
				const iterator = Rows.primaryStore.getRange({ transaction: native })[Symbol.iterator]();
				while (!txn.timedOut) {
					assert.notEqual(iterator.next().done, true);
					await waitFor(() => !txn.rangeReadActive || txn.timedOut, { interval: 1 });
				}
				assert.throws(
					() => iterator.next(),
					(error) => error.statusCode === 422
				);
			}),
			(error) => error.statusCode === 422
		);
		assert.equal(await Rows.get(101), null);
	});
});
