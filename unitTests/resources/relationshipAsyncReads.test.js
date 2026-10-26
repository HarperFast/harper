require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

// A query that selects, filters on, or sorts by a relationship must read the related records through the
// async-capable path, so a related record that is not in memory is read in the background instead of
// blocking the worker.
describe('Queries read related records asynchronously', () => {
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
				{ name: 'childIds', elements: { type: 'ID' }, indexed: true },
				childAttribute,
				childrenAttribute,
			],
		});
		ColdChild = table({
			table: 'ColdChild',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'label' }, // not indexed, so a condition on it runs as a record filter rather than an index join
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
			await ColdChild.put({ id: 'child-' + i, name: 'child ' + i, label: 'label ' + i });
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

	// Count a table's record reads by path: a sync read blocks the worker on a cold record, an async read
	// returns a Promise when the record has to be read from storage. With simulateCold, every async read
	// returns a Promise, as a read that misses every in-memory cache does.
	function instrumentReads(Table, simulateCold) {
		const store = Table.primaryStore;
		const reads = { sync: 0, async: 0, promised: 0 };
		const originals = {};
		let depth = 0; // count only the outermost call, not one store method calling another
		const instrument = (method, isAsync) => {
			const original = (originals[method] = store[method]);
			store[method] = function (id, options) {
				if (depth > 0) return original.call(this, id, options);
				depth++;
				let result;
				try {
					result = original.call(this, id, options);
				} finally {
					depth--;
				}
				if (!isAsync(options)) {
					reads.sync++;
					return result;
				}
				reads.async++;
				if (simulateCold && !result?.then) result = Promise.resolve(result);
				if (result?.then) reads.promised++;
				return result;
			};
		};
		instrument('getEntry', (options) => options?.async);
		instrument('get', () => true);
		instrument('getSync', () => false);
		reads.restore = () => {
			for (const method in originals) store[method] = originals[method];
		};
		return reads;
	}

	async function collect(iterable) {
		const results = [];
		for await (const record of iterable) results.push(record);
		return results;
	}

	const firstFourParents = { attribute: 'id', comparator: 'between', value: ['parent-0', 'parent-3'] };

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
					conditions: [firstFourParents],
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

		describe('select', function () {
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

		describe('filter', function () {
			it('many-to-one', async function () {
				const results = await collect(
					ColdParent.search({
						conditions: [firstFourParents, { attribute: ['child', 'label'], value: 'label 2' }],
						select: ['id'],
					})
				);
				assert.deepEqual(results, [{ id: 'parent-2' }]);
				assert.equal(childReads.sync, 0);
				assert(childReads.promised >= 4, 'each parent read its related child in the background');
			});

			it('many-to-many, selecting only the matching related records', async function () {
				const results = await collect(
					ColdParent.search({
						conditions: [firstFourParents, { attribute: ['children', 'label'], value: 'label 9' }],
						select: ['id', { name: 'children', select: ['name'] }],
					})
				);
				assert.deepEqual(results, [{ id: 'parent-1', children: [{ name: 'child 9' }] }]);
				assert.equal(childReads.sync, 0);
				assert(childReads.promised > 0);
			});

			it('an OR group of relationship conditions', async function () {
				const results = await collect(
					ColdParent.search({
						conditions: [
							firstFourParents,
							{
								operator: 'or',
								conditions: [
									{ attribute: ['child', 'label'], value: 'label 0' },
									{ attribute: ['child', 'label'], value: 'label 3' },
								],
							},
						],
						select: ['id'],
					})
				);
				assert.deepEqual(results, [{ id: 'parent-0' }, { id: 'parent-3' }]);
				assert.equal(childReads.sync, 0);
				assert(childReads.promised > 0);
			});

			it('a leading one-to-many join', async function () {
				const results = await collect(
					ColdChild.search({
						conditions: [{ attribute: ['parents', 'childId'], value: 'child-1' }],
						select: ['id'],
					})
				);
				assert.deepEqual(results, [{ id: 'child-1' }]);
				assert.equal(parentReads.sync, 0);
				assert(parentReads.promised > 0, 'the joined parent was read in the background');
			});

			it('a leading many-to-many join with another condition on the same relationship', async function () {
				const results = await collect(
					ColdParent.search({
						conditions: [
							{ attribute: ['children', 'name'], comparator: 'starts_with', value: 'child 1' },
							{ attribute: ['children', 'id'], value: 'child-10' },
						],
						select: ['id'],
					})
				);
				assert.deepEqual(results, [{ id: 'parent-2' }]);
				assert.equal(childReads.sync, 0);
				assert(childReads.promised > 0, 'the joined children were read in the background');
			});
		});

		it('sort by a related attribute', async function () {
			const results = await collect(
				ColdParent.search({
					conditions: [firstFourParents],
					sort: { attribute: ['child', 'label'], descending: true },
					select: ['id'],
				})
			);
			assert.deepEqual(
				results.map((record) => record.id),
				['parent-3', 'parent-2', 'parent-1', 'parent-0']
			);
			assert.equal(childReads.sync, 0);
			assert(childReads.promised >= 4, 'each sort key read its related child in the background');
		});
	});
});
