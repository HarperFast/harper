'use strict';
const assert = require('node:assert/strict');
const { describe, it, before } = globalThis.describe ? globalThis : require('node:test');
const { setupTestDBPath } = require('../testUtils');
const { table, databases } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { collapseData, hasChanges, collapseChanges, updateAndFreeze } = require('#src/resources/tracked');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

describe('Tracked instance own properties: class-field baselines in every merge, and undeclared-property reads', () => {
	let BaseTable;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		BaseTable = table({
			table: 'OwnPropBase',
			database: 'test_tracked_own_props',
			sealed: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'hits', type: 'Int' },
				{ name: 'tag', type: 'String' },
				{ name: 'count', type: 'Int' },
			],
		});
	});

	it('untouched class fields are not committed, and addTo commits (positive control)', async () => {
		class WithField extends BaseTable {
			hits = 0;
			tag = 'default';
			meta = { values: [1] };
		}
		databases.test_tracked_own_props.OwnPropBase = WithField;

		await BaseTable.put('pc-1', {
			title: 'init',
			hits: 100,
			tag: 'important',
			count: 10,
			unindexedCount: 20,
		});

		await transaction(async (ctx) => {
			const rec = await WithField.update('pc-1', ctx);
			assert.equal(hasChanges(rec), false);
			assert.equal(collapseChanges(rec), undefined);

			rec.title = 'updated';
			rec.addTo('count', 5);
			assert.equal(rec.count, 15);
			assert.equal(rec.get('count'), 15);

			rec.addTo('unindexedCount', 5);
			assert.equal(hasChanges(rec), true);
		});

		const stored = await BaseTable.get('pc-1');
		assert.equal(stored.title, 'updated');
		assert.equal(stored.hits, 100);
		assert.equal(stored.tag, 'important');
		assert.equal(stored.count, 15);
		assert.equal(stored.unindexedCount, 25);
		assert.equal('meta' in stored, false);
	});

	it('a source patch event and a non-instance _writeUpdate through a subclass keep stored values over untouched class fields', async () => {
		let notifySource;
		let closeSource;
		const putCalls = [];

		const SourcedTable = table({
			table: 'OwnPropSourced',
			database: 'test_tracked_own_props',
			sealed: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'tag', type: 'String' },
				{ name: 'hits', type: 'Int' },
			],
		});

		SourcedTable.sourcedFrom({
			subscribe() {
				const queue = [];
				let waiting = null;
				notifySource = (event) =>
					new Promise((resolve) => {
						const item = { ...event, onCommit: resolve };
						if (waiting) {
							const w = waiting;
							waiting = null;
							w({ value: item, done: false });
						} else {
							queue.push(item);
						}
					});
				closeSource = () => {
					if (waiting) {
						const w = waiting;
						waiting = null;
						w({ value: undefined, done: true });
					}
				};
				return {
					[Symbol.asyncIterator]() {
						return {
							next() {
								if (queue.length > 0) {
									return Promise.resolve({ value: queue.shift(), done: false });
								}
								return new Promise((resolve) => {
									waiting = resolve;
								});
							},
						};
					},
				};
			},
			put(id, data) {
				putCalls.push({ id, data: { ...data } });
			},
		});

		class SourcedWithField extends SourcedTable {
			tag = 'default';
			hits = 0;
		}
		databases.test_tracked_own_props.OwnPropSourced = SourcedWithField;

		await SourcedTable.put('src-1', {
			title: 'initial',
			tag: 'important',
			hits: 100,
		});
		await SourcedTable.put('src-2', {
			title: 'initial-2',
			tag: 'important-2',
			hits: 200,
		});
		putCalls.length = 0;

		assert.equal(typeof notifySource, 'function');
		await notifySource({
			type: 'patch',
			table: 'OwnPropSourced',
			id: 'src-1',
			value: { title: 'from-source-patch' },
		});
		closeSource?.();

		await transaction(async (ctx) => {
			const rec = await SourcedWithField.update('src-2', ctx);
			rec._writeUpdate('src-2', { title: 'from-write-update' }, false);
		});

		const stored1 = await SourcedTable.get('src-1');
		const stored2 = await SourcedTable.get('src-2');
		const src2Put = putCalls.find((c) => c.id === 'src-2');
		assert.ok(src2Put, 'Expected source.put to be called for src-2');

		assert.equal(stored1.title, 'from-source-patch');
		assert.equal(stored1.tag, 'important');
		assert.equal(stored1.hits, 100);

		assert.equal(stored2.title, 'from-write-update');
		assert.equal(stored2.tag, 'important-2');
		assert.equal(stored2.hits, 200);

		assert.equal(src2Put.data.title, 'from-write-update');
		assert.equal(src2Put.data.tag, 'important-2');
		assert.equal(src2Put.data.hits, 200);
	});

	it('collapseData, toJSON and updateAndFreeze leave out untouched class fields and keep pending addTo deltas', async () => {
		class Helper {
			calls = 0;
		}
		class WithField extends BaseTable {
			hits = 0;
			tag = 'default';
			meta = { values: [1] };
			helper = new Helper();
		}
		databases.test_tracked_own_props.OwnPropBase = WithField;

		await BaseTable.put('cd-1', {
			title: 'seeded',
			hits: 100,
			tag: 'important',
		});

		// (a) Before any mutation (hasChanges(rec) === false)
		await transaction(async (ctx) => {
			const rec = await WithField.update('cd-1', ctx);
			assert.equal(hasChanges(rec), false);

			const collapsed = collapseData(rec);
			const json = rec.toJSON();
			const frozen = updateAndFreeze(rec);

			for (const snapshot of [collapsed, json, frozen]) {
				assert.equal(snapshot.hits, 100);
				assert.equal(snapshot.tag, 'important');
				assert.equal('meta' in snapshot, false);
				assert.equal('helper' in snapshot, false);
			}
		});

		// (b) After rec.addTo('hits', 5) while own property rec.hits remains at baseline 0
		await transaction(async (ctx) => {
			const rec = await WithField.update('cd-1', ctx);
			rec.addTo('hits', 5);

			const collapsed = collapseData(rec);
			const json = rec.toJSON();
			const frozen = updateAndFreeze(rec);

			assert.equal(collapsed.hits, 105);
			assert.equal(json.hits, 105);
			assert.equal(frozen.hits, 105);
		});

		// (c) When own class fields ARE intentionally mutated, all three include the mutations
		await transaction(async (ctx) => {
			const rec = await WithField.update('cd-1', ctx);
			rec.tag = 'custom-tag';
			rec.meta.values.push(2);

			const collapsed = collapseData(rec);
			const json = rec.toJSON();
			const frozen = updateAndFreeze(rec);

			for (const snapshot of [collapsed, json, frozen]) {
				assert.equal(snapshot.tag, 'custom-tag');
				assert.deepEqual(snapshot.meta, { values: [1, 2] });
			}
		});
	});

	it('reading an undeclared property after addTo/subtractFrom returns the computed value, not the pending Addition', async () => {
		databases.test_tracked_own_props.OwnPropBase = BaseTable;

		await BaseTable.put('add-undeclared', {
			title: 'u',
			unindexedCount: 20,
			unindexedBig: 50n,
		});

		await transaction(async (ctx) => {
			const rec = await BaseTable.update('add-undeclared', ctx);
			rec.addTo('unindexedCount', 5);
			rec.subtractFrom('unindexedCount', 3);
			rec.addTo('unindexedBig', 10n);
			rec.addTo('brandNewCounter', 7);

			assert.equal(rec.unindexedCount, 22);
			assert.equal(rec.get('unindexedCount'), 22);
			assert.equal(rec.getProperty('unindexedCount'), 22);

			assert.equal(rec.unindexedBig, 60n);
			assert.equal(rec.get('unindexedBig'), 60n);
			assert.equal(rec.getProperty('unindexedBig'), 60n);

			assert.equal(rec.brandNewCounter, 7);
			assert.equal(rec.get('brandNewCounter'), 7);
			assert.equal(rec.getProperty('brandNewCounter'), 7);
		});
	});

	it('get/getProperty of an undeclared property reflect own assignment, deleteProperty and nested mutation', async () => {
		databases.test_tracked_own_props.OwnPropBase = BaseTable;

		await BaseTable.put('get-prop-1', {
			title: 'g',
			extra: 'v1',
			toDelete: 'gone-soon',
			unindexedObj: { nested: 'orig', count: 1 },
			unindexedArr: ['a'],
		});

		await transaction(async (ctx) => {
			const rec = await BaseTable.update('get-prop-1', ctx);

			// (a) Direct own-property assignment on undeclared property
			rec.extra = 'v2';
			assert.equal(rec.get('extra'), 'v2');
			assert.equal(rec.getProperty('extra'), 'v2');

			// (b) Delete undeclared property via deleteProperty
			rec.deleteProperty('toDelete');
			assert.equal(rec.toDelete, undefined);
			assert.equal(rec.get('toDelete'), undefined);
			assert.equal(rec.getProperty('toDelete'), undefined);

			// (c) Nested mutation through rec.get('unindexedObj') and rec.get('unindexedArr')
			const obj = rec.get('unindexedObj');
			obj.nested = 'mutated';
			const arr = rec.get('unindexedArr');
			arr.push('b');
			assert.equal(hasChanges(rec), true);
		});

		const stored = await BaseTable.get('get-prop-1');
		assert.equal(stored.extra, 'v2');
		assert.equal(stored.toDelete, undefined);
		assert.deepEqual(stored.unindexedObj, { nested: 'mutated', count: 1 });
		assert.deepEqual(stored.unindexedArr, ['a', 'b']);
	});
});
