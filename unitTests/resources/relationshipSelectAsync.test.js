require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// Selecting a relationship in a query must read related records through the async-capable path, so a
// related record that is not in memory is read in the background instead of blocking the worker.
describe('Selecting related records reads them asynchronously', () => {
	let ColdParent, ColdChild;
	const childCount = 20;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		const childAttribute = {
			name: 'child',
			type: 'ColdChild',
			relationship: { from: 'childId' },
			definition: {},
		};
		const childrenAttribute = {
			name: 'children',
			elements: { type: 'ColdChild', definition: {} },
			relationship: { from: 'childIds', filterMissing: true },
		};
		ColdParent = table({
			table: 'ColdParent',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'childId', indexed: true },
				{ name: 'childIds', elements: { type: 'ID' } },
				childAttribute,
				childrenAttribute,
			],
		});
		ColdChild = table({
			table: 'ColdChild',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name' },
				{
					name: 'parents',
					relationship: { to: 'childId' },
					elements: { type: 'ColdParent', definition: { tableClass: ColdParent } },
				},
			],
		});
		childAttribute.definition.tableClass = ColdChild;
		childrenAttribute.elements.definition.tableClass = ColdChild;
		for (let i = 0; i < childCount; i++) {
			await ColdChild.put({ id: 'child-' + i, name: 'child ' + i });
		}
		for (let i = 0; i < 4; i++) {
			await ColdParent.put({
				id: 'parent-' + i,
				childId: 'child-' + i,
				// child-missing exercises filterMissing
				childIds: ['child-' + (i + 4), 'child-missing', 'child-' + (i + 8)],
			});
		}
	});

	// Count the related table's reads by path: a sync read blocks the worker on a cold record, an async
	// read returns a Promise when the record has to be read from storage.
	function instrumentReads(Table, simulateCold) {
		const store = Table.primaryStore;
		const originalGetEntry = store.getEntry;
		const reads = { sync: 0, async: 0, promised: 0 };
		store.getEntry = function (id, options) {
			if (options?.async) {
				reads.async++;
				const result = simulateCold
					? Promise.resolve(originalGetEntry.call(this, id, { ...options, async: false }))
					: originalGetEntry.call(this, id, options);
				if (result?.then) reads.promised++;
				return result;
			}
			reads.sync++;
			return originalGetEntry.call(this, id, options);
		};
		reads.restore = () => {
			store.getEntry = originalGetEntry;
		};
		return reads;
	}

	async function collect(iterable) {
		const results = [];
		for await (const record of iterable) results.push(record);
		return results;
	}

	it('reads a genuinely cold many-to-one related record in the background (RocksDB)', async function () {
		if (isLMDB) return this.skip();
		const store = ColdChild.primaryStore;
		// move the children out of the memtable into an SST file and drop Harper's record cache, so the
		// next read of a child's data block misses every in-memory layer
		store.flushSync();
		store.cache?.clear();
		const reads = instrumentReads(ColdChild, false);
		let results;
		try {
			results = await collect(
				ColdParent.search({
					conditions: [{ attribute: 'id', comparator: 'between', value: ['parent-0', 'parent-3'] }],
					select: ['id', { name: 'child', select: ['id', 'name'] }],
				})
			);
		} finally {
			reads.restore();
		}
		assert.deepEqual(
			results.map((record) => record.child.name),
			['child 0', 'child 1', 'child 2', 'child 3']
		);
		assert.equal(reads.sync, 0, 'no related record was read on the blocking path');
		assert(reads.promised > 0, 'the cold related read returned a Promise (background read)');
	});

	describe('with every related read cold', function () {
		let childReads, parentReads;
		beforeEach(function () {
			childReads = instrumentReads(ColdChild, true);
			parentReads = instrumentReads(ColdParent, true);
		});
		afterEach(function () {
			childReads.restore();
			parentReads.restore();
		});

		it('many-to-one', async function () {
			const results = await collect(
				ColdParent.search({
					conditions: [{ attribute: 'id', value: 'parent-1' }],
					select: ['id', 'child'],
				})
			);
			assert.equal(results[0].child.name, 'child 1');
			assert.equal(childReads.sync, 0);
			assert.equal(childReads.promised, 1);
		});

		it('many-to-many with filterMissing', async function () {
			const results = await collect(
				ColdParent.search({
					conditions: [{ attribute: 'id', value: 'parent-2' }],
					select: ['id', { name: 'children', select: ['name'] }],
				})
			);
			assert.deepEqual(results[0].children, [{ name: 'child 6' }, { name: 'child 10' }]);
			assert.equal(childReads.sync, 0);
			assert.equal(childReads.promised, 3);
		});

		it('many-to-many sorted', async function () {
			const results = await collect(
				ColdParent.search({
					conditions: [{ attribute: 'id', value: 'parent-0' }],
					select: ['id', { name: 'children', select: ['name'], sort: { attribute: 'name', descending: true } }],
				})
			);
			assert.deepEqual(results[0].children, [{ name: 'child 8' }, { name: 'child 4' }]);
			assert.equal(childReads.sync, 0);
		});

		it('one-to-many', async function () {
			const results = await collect(
				ColdChild.search({
					conditions: [{ attribute: 'id', value: 'child-3' }],
					select: ['id', { name: 'parents', select: ['id'] }],
				})
			);
			assert.deepEqual(results[0].parents, [{ id: 'parent-3' }]);
			assert.equal(parentReads.sync, 0);
			assert.equal(parentReads.promised, 1);
		});
	});
});
