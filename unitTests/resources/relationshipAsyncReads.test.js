require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { transaction } = require('#src/resources/transaction');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

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
				childIds: ['child-' + (i + 4), 'child-missing', 'child-' + (i + 8)],
			});
		}
		// shares parent-1's child, for sorts with ties
		await ColdParent.put({ id: 'parent-4', childId: 'child-1', childIds: [] });
		await ColdParent.put({ id: 'parent-null', childId: null, childIds: null });
		// more related ids than may be read at once (RELATED_READS_IN_FLIGHT)
		await ColdParent.put({ id: 'parent-wide', childIds: Array.from({ length: 40 }, (_, i) => 'child-' + (i % 4)) });
	});

	function instrumentReads(Table, simulateCold) {
		const store = Table.primaryStore;
		const reads = { sync: 0, async: 0, promised: 0, inFlight: 0, maxInFlight: 0 };
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
				if (simulateCold) {
					const settled = result;
					reads.maxInFlight = Math.max(reads.maxInFlight, ++reads.inFlight);
					result = new Promise((resolve, reject) =>
						setImmediate(() => {
							reads.inFlight--;
							Promise.resolve(settled).then(resolve, reject);
						})
					);
				}
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

	// snapshot each record as it is yielded: a projection that settles after the row is handed out would
	// otherwise look complete once the whole result is collected
	async function collect(iterable) {
		const results = [];
		for await (const record of iterable) results.push(JSON.parse(JSON.stringify(record)));
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
			childReads?.restore();
			parentReads?.restore();
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
				assert.equal(
					childReads.maxInFlight,
					3,
					"a row's related reads should go to storage together, not one round trip at a time"
				);
			});

			it('many-to-many with more related records than may be read at once', async function () {
				const results = await collect(
					ColdParent.search({
						conditions: [{ attribute: 'id', value: 'parent-wide' }],
						select: ['id', { name: 'children', select: ['id'] }],
					})
				);
				assert.equal(results[0].children.length, 40);
				assert.equal(results[0].children[5].id, 'child-1');
				assert.equal(childReads.maxInFlight, 16, 'at most 16 related reads in flight, and the window is used');
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

			it('under synchronous iteration, a relationship filter keeps its synchronous form', function () {
				const results = [
					...ColdParent.search({
						conditions: [firstFourParents, { attribute: ['child', 'label'], value: 'label 2' }],
						select: ['id'],
					}),
				];
				assert.deepEqual(results, [{ id: 'parent-2' }]);
				assert(childReads.sync > 0, 'a synchronous iteration cannot wait on a background read');
			});

			it('under synchronous iteration, a filtered many-to-many select stays synchronous', function () {
				const results = [
					...ColdParent.search({
						conditions: [firstFourParents, { attribute: ['children', 'label'], value: 'label 9' }],
						select: ['id', { name: 'children', select: ['name'] }],
					}),
				];
				assert.deepEqual(results, [{ id: 'parent-1', children: [{ name: 'child 9' }] }]);
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

		it('select of a filtered many-to-many relationship with a nested sort is complete when the row is yielded', async function () {
			const results = await collect(
				ColdParent.search({
					conditions: [
						firstFourParents,
						{ attribute: ['children', 'label'], comparator: 'starts_with', value: 'label 1' },
					],
					select: ['id', { name: 'children', select: ['name'], sort: { attribute: 'name' } }],
				})
			);
			assert.deepEqual(results, [
				{ id: 'parent-2', children: [{ name: 'child 10' }] },
				{ id: 'parent-3', children: [{ name: 'child 11' }] },
			]);
			assert.equal(childReads.sync, 0);
		});

		it('select of a filtered relationship on a row whose foreign key is null', async function () {
			const results = await collect(
				ColdParent.search({
					conditions: [
						{ attribute: 'id', comparator: 'between', value: ['parent-0', 'parent-null'] },
						{
							operator: 'or',
							conditions: [
								{ attribute: ['children', 'label'], value: 'label 9' },
								{ attribute: 'id', value: 'parent-null' },
							],
						},
					],
					select: ['id', { name: 'children', select: ['name'] }],
				})
			);
			assert.deepEqual(results, [{ id: 'parent-1', children: [{ name: 'child 9' }] }, { id: 'parent-null' }]);
			assert.equal(childReads.sync, 0);
		});

		it('sort whose index-ordered first key is a related attribute keeps ties in the next key order', async function () {
			const results = await collect(
				ColdParent.search({
					conditions: [{ attribute: ['child', 'name'], comparator: 'starts_with', value: 'child 1' }],
					sort: { attribute: ['child', 'name'], next: { attribute: 'id', descending: true } },
					select: ['id'],
				})
			);
			assert.deepEqual(
				results.map((record) => record.id),
				['parent-4', 'parent-1']
			);
			assert.equal(childReads.sync, 0);
		});

		it('sort by the relationship itself', async function () {
			const results = await collect(
				ColdParent.search({ conditions: [firstFourParents], sort: { attribute: 'child' }, select: ['id'] })
			);
			assert.equal(results.length, 4);
			assert.equal(childReads.sync, 0);
		});

		describe('when the request is torn down mid-query', function () {
			// A handler that started a query and then failed ends its scope without ever returning the query's
			// iterator; the transaction releases the read snapshot under it. A scan waiting on a related read
			// then fails the way a range read over a released snapshot does, with the expired-snapshot error.
			// RocksDB only: a released LMDB read transaction is not detectable here, and LMDB range reads drain on.
			async function tearDownAfterFirstNext(Table, query) {
				const context = {};
				let pending;
				await assert.rejects(
					transaction(context, async () => {
						pending = Table.search(query, context)[Symbol.asyncIterator]().next();
						throw new Error('handler failed');
					}),
					/handler failed/
				);
				await assert.rejects(pending, { name: 'ReadSnapshotExpiredError', statusCode: 503 });
			}

			it('a sort by a related attribute reads no more related records', async function () {
				if (isLMDB) return this.skip();
				await tearDownAfterFirstNext(ColdParent, {
					conditions: [firstFourParents],
					sort: { attribute: ['child', 'label'] },
					select: ['id'],
				});
				assert.equal(childReads.async + childReads.sync, 0, 'no sort key was read after teardown');
			});

			it('a leading one-to-many join stops scanning', async function () {
				if (isLMDB) return this.skip();
				await tearDownAfterFirstNext(ColdChild, {
					conditions: [{ attribute: ['parents', 'childId'], comparator: 'starts_with', value: 'child' }],
					select: ['id'],
				});
				assert(parentReads.async <= 1, `only the read already in flight completes (${parentReads.async} reads)`);
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
