const assert = require('node:assert');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const {
	collapseData,
	hasChanges,
	collapseChanges,
	recordOwnBaseline,
	releaseOwnBaseline,
} = require('#src/resources/tracked');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { createBlob, isSaving, getFilePathForBlob } = require('#src/resources/blob');
const { existsSync } = require('node:fs');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');

describe('Tracked instance update: collapseData, addTo/subtractFrom, and the committed patch (audit, source.patch, CRDT)', () => {
	let QA1955Table;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);

		QA1955Table = table({
			table: 'QA1955Table',
			database: 'test_qa1955',
			audit: true,
			sealed: false,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'title', type: 'String' },
				{ name: 'count', type: 'Float' },
				{ name: 'countInt', type: 'Int' },
				{ name: 'countLong', type: 'Long' },
				{ name: 'countBigInt', type: 'BigInt' },
				{
					name: 'subObject',
					type: 'Object',
					properties: [
						{ name: 'name', type: 'String' },
						{ name: 'keep', type: 'String' },
						{ name: 'count', type: 'Int' },
					],
				},
				{ name: 'tags', type: 'Array', elements: { type: 'String' } },
				{
					name: 'items',
					type: 'Array',
					elements: {
						type: 'Object',
						properties: [
							{ name: 'label', type: 'String' },
							{ name: 'qty', type: 'Int' },
						],
					},
				},
			],
		});
	});

	describe('Arm 1 (Positive Control): baseline tracked scalar/sub-object/array mutations and single addTo', () => {
		it('persists scalar property assignment, nested subObject mutation, array push, and single addTo/subtractFrom on primary storage', async () => {
			await QA1955Table.put('ctrl-1', {
				title: 'initial',
				count: 10,
				countInt: 5,
				countLong: 100,
				countBigInt: 50n,
				subObject: { name: 'orig', keep: 'stay', count: 1 },
				tags: ['alpha', 'beta'],
				items: [{ label: 'first', qty: 2 }],
			});

			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('ctrl-1', ctx);
				rec.title = 'updated';
				rec.subObject.name = 'changed';
				rec.tags.push('gamma');
				rec.addTo('count', 5);
				rec.subtractFrom('countInt', 2);
				rec.addTo('countBigInt', 10n);
			});

			const saved = await QA1955Table.get('ctrl-1');
			assert.strictEqual(saved.title, 'updated');
			assert.strictEqual(saved.subObject.name, 'changed');
			assert.strictEqual(saved.subObject.keep, 'stay');
			assert.strictEqual(saved.subObject.count, 1);
			assert.deepStrictEqual(Array.from(saved.tags), ['alpha', 'beta', 'gamma']);
			assert.strictEqual(saved.count, 15);
			assert.strictEqual(saved.countInt, 3);
			assert.strictEqual(saved.countBigInt, 60n);
		});
	});

	describe('Arm 2 (Mechanism 1): Table.commit tracked mutation vs source.patch, audit reconstruction, and CRDT reconciliation', () => {
		it('Test 2a: tracked nested sub-object mutation preserves sibling sub-object properties in source.patch, audit getRecordAtTime, and CRDT out-of-order reconciliation', async () => {
			const patchedPayloads = [];
			const QA1955SourcedTable = table({
				table: 'QA1955SourcedTable',
				database: 'test_qa1955',
				audit: true,
				sealed: false,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
					{
						name: 'subObject',
						type: 'Object',
						properties: [
							{ name: 'name', type: 'String' },
							{ name: 'keep', type: 'String' },
							{ name: 'count', type: 'Int' },
						],
					},
				],
			});
			QA1955SourcedTable.sourcedFrom({
				get(id) {
					return {
						id,
						title: 'sourced-v1',
						subObject: { name: 'initial', keep: 'preserved', count: 1 },
					};
				},
				patch(id, data) {
					patchedPayloads.push({
						id,
						subObject: data.subObject,
					});
				},
			});

			await QA1955SourcedTable.put('src-1', {
				title: 'sourced-v1',
				subObject: { name: 'initial', keep: 'preserved', count: 1 },
			});
			await transaction(async (ctx) => {
				const rec = await QA1955SourcedTable.update('src-1', ctx);
				rec.subObject.name = 'mutated';
			});

			const baseTime = Date.now() + 100;
			const t1 = baseTime;
			const t1_5 = baseTime + 500;
			const t2 = baseTime + 1000;
			const t3 = baseTime + 2000;

			await QA1955Table.put(
				'arm2-a',
				{
					title: 'v1',
					subObject: { name: 'initial', keep: 'preserved', count: 1 },
					tags: ['a', 'b'],
				},
				{ timestamp: t1 }
			);

			await transaction(async (ctx2) => {
				const rec = await QA1955Table.update('arm2-a', ctx2);
				ctx2.timestamp = t2;
				if (ctx2.getContext) ctx2.getContext().timestamp = t2;
				rec.subObject.name = 'mutated-at-t2';
			});

			await QA1955Table.put('arm2-a', { title: 'v3' }, { timestamp: t3 });

			const history = await QA1955Table.getHistoryOfRecord('arm2-a');
			const atT2 = history.find((entry) => entry.type === 'patch').value;

			await QA1955Table.put(
				'arm2-b',
				{
					title: 'v1',
					subObject: { name: 'initial', keep: 'preserved', count: 1 },
					tags: ['a', 'b'],
				},
				{ timestamp: t1 }
			);

			await transaction(async (ctx2) => {
				const rec = await QA1955Table.update('arm2-b', ctx2);
				ctx2.timestamp = t2;
				if (ctx2.getContext) ctx2.getContext().timestamp = t2;
				rec.subObject.name = 'mutated-at-t2';
			});

			await QA1955Table.put(
				'arm2-b',
				{
					title: 'from-t1',
					subObject: { name: 'from-t1', keep: 'from-t1', count: 9 },
				},
				{ timestamp: t1_5 }
			);

			const reconciled = await QA1955Table.get('arm2-b');
			assert.strictEqual(patchedPayloads.length, 1);
			assert.deepStrictEqual(patchedPayloads[0].subObject, {
				name: 'mutated',
				keep: 'preserved',
				count: 1,
			});
			assert.deepStrictEqual(
				{ ...atT2.subObject },
				{
					name: 'mutated-at-t2',
					keep: 'preserved',
					count: 1,
				}
			);
			assert.deepStrictEqual(
				{ ...reconciled.subObject },
				{
					name: 'mutated-at-t2',
					keep: 'preserved',
					count: 1,
				}
			);
		});

		it('Test 2b: read-only access of nested sub-object or array during tracked update does not overwrite concurrent out-of-order patches to those properties', async () => {
			const baseTime = Date.now() + 100;
			const t1 = baseTime;
			const t1_5 = baseTime + 500;
			const t2 = baseTime + 1000;

			await QA1955Table.put(
				'arm2-readonly',
				{
					title: 'v1',
					subObject: { name: 'init', keep: 'yes', count: 1 },
					tags: ['a', 'b'],
				},
				{ timestamp: t1 }
			);

			await transaction(async (ctx2) => {
				const rec = await QA1955Table.update('arm2-readonly', ctx2);
				ctx2.timestamp = t2;
				if (ctx2.getContext) ctx2.getContext().timestamp = t2;
				const observedSubName = rec.subObject.name;
				const observedTag = rec.tags[0];
				assert.strictEqual(observedSubName, 'init');
				assert.strictEqual(observedTag, 'a');
				rec.title = 'title-at-t2';
			});

			await QA1955Table.patch(
				'arm2-readonly',
				{
					subObject: { name: 'patched-at-t1', keep: 'yes', count: 2 },
					tags: ['x', 'y'],
				},
				{ timestamp: t1_5 }
			);

			const finalRec = await QA1955Table.get('arm2-readonly');
			assert.strictEqual(finalRec.title, 'title-at-t2');
			assert.deepStrictEqual(
				{ ...finalRec.subObject },
				{
					name: 'patched-at-t1',
					keep: 'yes',
					count: 2,
				}
			);
			assert.deepStrictEqual(Array.from(finalRec.tags), ['x', 'y']);
		});
	});

	describe('Arm 3 (Mechanism 2): collapseData, hasChanges, unindexed property assignment, and setter coercion', () => {
		it('Test 3a: reading an array or nested object element without mutating it reports hasChanges(record) === false and skips the commit write', async () => {
			await QA1955Table.put('arm3-a', {
				title: 'v1',
				subObject: { name: 'sub1', keep: 'k1', count: 1 },
				tags: ['a', 'b'],
			});

			const vBefore = (await QA1955Table.primaryStore.getEntry('arm3-a')).version;

			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('arm3-a', ctx);
				const firstTag = rec.tags[0];
				const subName = rec.subObject.name;
				assert.strictEqual(firstTag, 'a');
				assert.strictEqual(subName, 'sub1');
				assert.strictEqual(hasChanges(rec), false);
			});

			const vAfter = (await QA1955Table.primaryStore.getEntry('arm3-a')).version;
			assert.strictEqual(vAfter, vBefore);
		});

		it('Test 3b: direct assignment of unindexed property on non-sealed table marks hasChanges(record) === true and persists on commit', async () => {
			await QA1955Table.put('arm3-b', {
				title: 'v1',
				countLong: 10,
			});

			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('arm3-b', ctx);
				rec.extraDynamicProp = 'saved-extra';
				assert.strictEqual(hasChanges(rec), true);
			});

			const afterDynamic = await QA1955Table.get('arm3-b');
			assert.strictEqual(afterDynamic.extraDynamicProp, 'saved-extra');
			assert.strictEqual(afterDynamic.title, 'v1');
			assert.strictEqual(afterDynamic.countLong, 10);
		});

		it('Test 3c: array in-place mutation and array-of-objects element mutation produce full updated arrays in collapseData', async () => {
			await QA1955Table.put('arm3-c', {
				title: 'v1',
				tags: ['a', 'b', 'c'],
				items: [
					{ label: 'item1', qty: 1 },
					{ label: 'item2', qty: 2 },
				],
			});

			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('arm3-c', ctx);
				const firstTag = rec.tags[0];
				assert.strictEqual(firstTag, 'a');

				const c1 = collapseData(rec);
				assert.strictEqual(Array.isArray(c1.tags), true);
				assert.deepStrictEqual(c1.tags, ['a', 'b', 'c']);

				rec.tags.pop();
				rec.items[0].qty = 99;
				const c2 = collapseData(rec);
				assert.strictEqual(Array.isArray(c2.tags), true);
				assert.deepStrictEqual(c2.tags, ['a', 'b']);
				assert.strictEqual(Array.isArray(c2.items), true);
				assert.deepStrictEqual(c2.items, [
					{ label: 'item1', qty: 99 },
					{ label: 'item2', qty: 2 },
				]);

				rec.tags.length = 0;
				const c3 = collapseData(rec);
				assert.strictEqual(Array.isArray(c3.tags), true);
				assert.deepStrictEqual(c3.tags, []);
			});
		});
	});

	describe('Arm 4 (Mechanism 3): addTo and subtractFrom BigInt negation and multi-call composition', () => {
		it('Test 4a: subtractFrom on a BigInt property subtracts a BigInt delta without throwing TypeError', async () => {
			await QA1955Table.put('arm4-a', { countBigInt: 100n });

			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('arm4-a', ctx);
				rec.subtractFrom('countBigInt', 35n);
				assert.strictEqual(rec.countBigInt, 65n);
			});

			const after = await QA1955Table.get('arm4-a');
			assert.strictEqual(after.countBigInt, 65n);
		});

		it('Test 4b: multiple addTo and subtractFrom calls and prior direct property assignments within the same transaction compose additively', async () => {
			await QA1955Table.put('arm4-b', {
				count: 10,
				countInt: 20,
				countBigInt: 50n,
			});

			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('arm4-b', ctx);
				rec.addTo('count', 5);
				rec.addTo('count', 3);
				rec.subtractFrom('count', 2);

				rec.countInt = 100;
				rec.addTo('countInt', 7);

				rec.addTo('countBigInt', 10n);
				rec.subtractFrom('countBigInt', 4n);

				assert.strictEqual(rec.count, 16);
				assert.strictEqual(rec.countInt, 107);
				assert.strictEqual(rec.countBigInt, 56n);
			});

			const after = await QA1955Table.get('arm4-b');
			assert.strictEqual(after.count, 16);
			assert.strictEqual(after.countInt, 107);
			assert.strictEqual(after.countBigInt, 56n);
		});

		it('Test 4c: calling record.update({...}) followed by addTo/subtractFrom in the same transaction preserves BigInt arithmetic and composes deltas', async () => {
			await QA1955Table.put('arm4-c', {
				countBigInt: 10n,
				count: 5,
			});

			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('arm4-c', ctx);
				rec.update({ countBigInt: 100n, count: 20 }, true);
				rec.addTo('countBigInt', 25n);
				rec.subtractFrom('countBigInt', 5n);
				rec.addTo('count', 4);
				assert.strictEqual(rec.countBigInt, 120n);
				assert.strictEqual(rec.count, 24);
			});

			const after = await QA1955Table.get('arm4-c');
			assert.strictEqual(after.countBigInt, 120n);
			assert.strictEqual(after.count, 24);
		});
	});

	describe('The committed patch of a tracked instance', () => {
		let SourcedTable;
		const patched = [];
		before(() => {
			SourcedTable = table({
				table: 'TrackedPatchSourced',
				database: 'test_qa1955',
				audit: true,
				sealed: false,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
					{
						name: 'subObject',
						type: 'Object',
						properties: [
							{ name: 'name', type: 'String' },
							{ name: 'count', type: 'Int' },
						],
					},
					{ name: 'tags', type: 'Array', elements: { type: 'String' } },
					{ name: 'values' },
				],
			});
			SourcedTable.sourcedFrom({
				get(id) {
					return { id, title: 'from-source' };
				},
				patch(id, data) {
					patched.push({ id, data });
				},
			});
		});
		beforeEach(() => {
			patched.length = 0;
		});
		// the raw audit values (getHistoryOfRecord reconstructs full records)
		function auditedPatches(id) {
			return [...SourcedTable.auditStore.getRange({ start: 1 })]
				.filter((entry) => entry.tableId === SourcedTable.tableId && entry.recordId === id && entry.type === 'patch')
				.map((entry) => entry.getValue(SourcedTable.primaryStore));
		}

		it('a read-only tracked update calls no source.patch and appends no audit entry', async () => {
			await SourcedTable.put('ro', {
				title: 't',
				subObject: { name: 'n', count: 1 },
				tags: ['a', 'b'],
				values: [NaN, 0, '', false, null],
			});
			const historyBefore = (await SourcedTable.getHistoryOfRecord('ro')).length;
			await transaction(async (ctx) => {
				const rec = await SourcedTable.update('ro', ctx);
				assert.strictEqual(rec.subObject.name, 'n');
				assert.strictEqual(rec.tags[1], 'b');
				assert.ok(Number.isNaN(rec.values[0]));
				assert.strictEqual(hasChanges(rec), false);
			});
			assert.strictEqual(patched.length, 0);
			assert.strictEqual((await SourcedTable.getHistoryOfRecord('ro')).length, historyBefore);
		});

		it('source.patch and the audit entry carry the same plain patch: changed arrays and sub-objects, not the ones only read', async () => {
			await SourcedTable.put('mixed', {
				title: 't',
				subObject: { name: 'n', count: 1 },
				tags: ['a', 'b', 'c'],
				values: [{ v: 1 }, { v: 2 }],
			});
			await transaction(async (ctx) => {
				const rec = await SourcedTable.update('mixed', ctx);
				assert.strictEqual(rec.subObject.name, 'n');
				rec.tags.pop();
				rec.values[1].v = 20;
			});
			assert.strictEqual(patched.length, 1);
			const sent = patched[0].data;
			assert.deepStrictEqual(Object.keys(sent).sort(), ['tags', 'values']);
			assert.ok(Array.isArray(sent.tags) && !sent.tags.getRecord);
			assert.deepStrictEqual([...sent.tags], ['a', 'b']);
			assert.ok(Array.isArray(sent.values) && !sent.values[1].getRecord);
			assert.deepStrictEqual(
				sent.values.map((value) => ({ ...value })),
				[{ v: 1 }, { v: 20 }]
			);
			const audited = auditedPatches('mixed').at(-1);
			assert.deepStrictEqual(Object.keys(audited).sort(), ['tags', 'values']);
			assert.deepStrictEqual([...audited.tags], ['a', 'b']);
			const saved = await SourcedTable.get('mixed');
			assert.deepStrictEqual({ ...saved.subObject }, { name: 'n', count: 1 });
			assert.deepStrictEqual([...saved.tags], ['a', 'b']);
		});

		it('emptying a tracked array with length = 0 commits an empty array', async () => {
			await SourcedTable.put('empty', { title: 't', tags: ['a', 'b'] });
			await transaction(async (ctx) => {
				const rec = await SourcedTable.update('empty', ctx);
				rec.tags.length = 0;
			});
			assert.deepStrictEqual([...patched[0].data.tags], []);
			assert.deepStrictEqual([...(await SourcedTable.get('empty')).tags], []);
		});

		it('an own dynamic property alone writes, and appears in the audit entry and source.patch', async () => {
			await SourcedTable.put('own', { title: 't' });
			await transaction(async (ctx) => {
				const rec = await SourcedTable.update('own', ctx);
				rec.extra = 'dynamic';
			});
			assert.strictEqual((await SourcedTable.get('own')).extra, 'dynamic');
			assert.strictEqual(patched[0].data.extra, 'dynamic');
			const audited = auditedPatches('own').at(-1);
			assert.strictEqual(audited.extra, 'dynamic');
		});
	});

	describe('addTo composition, more orders', () => {
		it('an assignment after addTo replaces the pending delta', async () => {
			await QA1955Table.put('add-then-assign', { countInt: 20 });
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('add-then-assign', ctx);
				rec.addTo('countInt', 5);
				rec.countInt = 50;
				rec.addTo('countInt', 1);
			});
			assert.strictEqual((await QA1955Table.get('add-then-assign')).countInt, 51);
		});

		it('composed deltas stay a single delta that commutes with a concurrent write', async () => {
			await QA1955Table.put('add-concurrent', { countInt: 20 });
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('add-concurrent', ctx);
				rec.addTo('countInt', 5);
				rec.addTo('countInt', 3);
				await transaction({}, async (other) => {
					const concurrent = await QA1955Table.update('add-concurrent', other);
					concurrent.addTo('countInt', 100);
				});
			});
			assert.strictEqual((await QA1955Table.get('add-concurrent')).countInt, 128);
			const deltas = [...QA1955Table.auditStore.getRange({ start: 1 })]
				.filter((entry) => entry.tableId === QA1955Table.tableId && entry.recordId === 'add-concurrent')
				.map((entry) => entry.getValue(QA1955Table.primaryStore)?.countInt?.value)
				.filter((value) => value !== undefined)
				.sort((a, b) => a - b);
			assert.deepStrictEqual(deltas, [8, 100]);
		});
		it('composes with an undeclared property assigned on the instance', async () => {
			await QA1955Table.put('add-own', { title: 't' });
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('add-own', ctx);
				rec.dynamicCount = 100;
				rec.addTo('dynamicCount', 7);
			});
			assert.strictEqual((await QA1955Table.get('add-own')).dynamicCount, 107);
		});
		it('an own property set back to the stored value overrides a pending addTo', async () => {
			await QA1955Table.put('add-own-reset', { title: 't', dynamicCount: 20 });
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('add-own-reset', ctx);
				rec.addTo('dynamicCount', 5);
				rec.dynamicCount = 20;
				rec.title = 'changed';
			});
			const saved = await QA1955Table.get('add-own-reset');
			assert.strictEqual(saved.dynamicCount, 20);
			assert.strictEqual(saved.title, 'changed');
		});
		it('an own property overrides a pending addTo on a record that does not exist yet', async () => {
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('add-own-new', ctx);
				rec.addTo('dynamicCount', 5);
				rec.dynamicCount = undefined;
			});
			assert.strictEqual((await QA1955Table.get('add-own-new'))?.dynamicCount, undefined);
		});
		it('a full update composes addTo with an undeclared property assigned on the instance', async () => {
			await QA1955Table.put('add-own-full', { title: 't' });
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('add-own-full', ctx);
				rec.update({ title: 'full' }, true);
				rec.dynamicCount = 100;
				rec.addTo('dynamicCount', 7);
				rec.addTo('dynamicCount', 1);
			});
			const saved = await QA1955Table.get('add-own-full');
			assert.strictEqual(saved.title, 'full');
			assert.strictEqual(saved.dynamicCount, 108);
		});
		it('a full update keeps an own value when its addTo throws', async () => {
			await QA1955Table.put('add-own-full-throw', { title: 't' });
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('add-own-full-throw', ctx);
				rec.update({ title: 'full' }, true);
				rec.dynamicCount = 100n;
				assert.throws(() => rec.addTo('dynamicCount', 0.5), RangeError);
				rec.addTo('dynamicCount', 1n);
			});
			assert.strictEqual((await QA1955Table.get('add-own-full-throw')).dynamicCount, 101n);
		});
		it('addTo after only reading an object field replaces the read value with the delta', async () => {
			await QA1955Table.put('add-after-read', { title: 't', dynamicObject: { a: 1 } });
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('add-after-read', ctx);
				assert.strictEqual(rec.dynamicObject.a, 1);
				rec.addTo('dynamicObject', 5);
			});
			const auditedValue = [...QA1955Table.auditStore.getRange({ start: 1 })]
				.filter((entry) => entry.tableId === QA1955Table.tableId && entry.recordId === 'add-after-read')
				.map((entry) => entry.getValue(QA1955Table.primaryStore)?.dynamicObject)
				.at(-1);
			assert.strictEqual(auditedValue?.__op__, 'add');
			assert.strictEqual(auditedValue.value, 5);
		});
		it('addTo folds into an assigned value whose getRecord property is not a function', async () => {
			await QA1955Table.put('add-getrecord-data', { title: 't' });
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('add-getrecord-data', ctx);
				rec.title = 'changed';
				rec.set('dynamicValue', { getRecord: 1 });
				assert.doesNotThrow(() => rec.addTo('dynamicValue', 5));
			});
			assert.strictEqual((await QA1955Table.get('add-getrecord-data')).dynamicValue, 5);
		});
		it('a data member named getRecord is stored as data, in an object and in an array', async () => {
			await QA1955Table.put('getrecord-data', { title: 't', tags: ['a'] });
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('getrecord-data', ctx);
				rec.title = 'changed';
				rec.extra = { getRecord: 1, name: 'keep' };
				rec.set('extraSet', { getRecord: true });
				rec.dynamicList = [{ getRecord: 'x' }];
			});
			const saved = await QA1955Table.get('getrecord-data');
			assert.deepStrictEqual({ ...saved.extra }, { getRecord: 1, name: 'keep' });
			assert.deepStrictEqual({ ...saved.extraSet }, { getRecord: true });
			assert.deepStrictEqual({ ...saved.dynamicList[0] }, { getRecord: 'x' });
		});
		it("folded deltas add in the stored value's numeric type", async () => {
			await QA1955Table.put('fold-bigint', { dynamicBig: 0n });
			await QA1955Table.put('fold-number', { dynamicNum: 10 });
			await transaction(async (ctx) => {
				const big = await QA1955Table.update('fold-bigint', ctx);
				big.addTo('dynamicBig', 1);
				big.addTo('dynamicBig', 9007199254740992n);
				const num = await QA1955Table.update('fold-number', ctx);
				num.addTo('dynamicNum', 1n);
				num.addTo('dynamicNum', 0.5);
			});
			assert.strictEqual((await QA1955Table.get('fold-bigint')).dynamicBig, 9007199254740993n);
			assert.strictEqual((await QA1955Table.get('fold-number')).dynamicNum, 11.5);
		});
	});

	describe('Reading untracked object values', () => {
		it('reading a Date or Bytes field is not a change', async () => {
			const DatedTable = table({
				table: 'TrackedDated',
				database: 'test_qa1955',
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
					{ name: 'when', type: 'Date' },
					{ name: 'bytes', type: 'Bytes' },
				],
			});
			await DatedTable.put('dated', { title: 't', when: new Date(1000), bytes: Buffer.from([1, 2]) });
			const versionBefore = DatedTable.primaryStore.getEntry('dated').version;
			await transaction(async (ctx) => {
				const rec = await DatedTable.update('dated', ctx);
				assert.strictEqual(rec.when.getTime(), 1000);
				assert.strictEqual(rec.bytes[0], 1);
				assert.strictEqual(hasChanges(rec), false);
			});
			assert.strictEqual(DatedTable.primaryStore.getEntry('dated').version, versionBefore);
		});
	});

	describe('Date and Bytes reads are copies', () => {
		let DatedCopyTable;
		before(() => {
			DatedCopyTable = table({
				table: 'TrackedDatedCopy',
				database: 'test_qa1955',
				audit: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
					{ name: 'when', type: 'Date' },
					{ name: 'bytes', type: 'Bytes' },
					{ name: 'dates', type: 'Array', elements: { type: 'Date' } },
					{ name: 'chunks', type: 'Array', elements: { type: 'Bytes' } },
				],
			});
		});
		const auditedPatch = (id) =>
			[...DatedCopyTable.auditStore.getRange({ start: 1 })]
				.filter((entry) => entry.tableId === DatedCopyTable.tableId && entry.recordId === id)
				.map((entry) => entry.getValue(DatedCopyTable.primaryStore))
				.at(-1);

		it('an in-place edit with another change reaches neither the stored record nor the patch', async () => {
			await DatedCopyTable.put('edit', { title: 't', when: new Date(1000), bytes: Buffer.from([1, 2]) });
			await transaction(async (ctx) => {
				const rec = await DatedCopyTable.update('edit', ctx);
				assert.strictEqual(rec.when, rec.when);
				rec.when.setTime(2000);
				assert(Buffer.isBuffer(rec.bytes));
				rec.bytes[0] = 9;
				assert.strictEqual(rec.when.getTime(), 2000);
				// the loaded record can be the commit base, so it must not see the edit
				assert.strictEqual(rec.getRecord().when.getTime(), 1000);
				assert.strictEqual(rec.getRecord().bytes[0], 1);
				rec.title = 'changed';
			});
			const saved = await DatedCopyTable.get('edit');
			assert.strictEqual(saved.title, 'changed');
			assert.strictEqual(saved.when.getTime(), 1000);
			assert.deepStrictEqual([...saved.bytes], [1, 2]);
			const patch = auditedPatch('edit');
			assert.strictEqual(patch.title, 'changed');
			assert.strictEqual(patch.when, undefined);
			assert.strictEqual(patch.bytes, undefined);
		});
		it('a Bytes array element edited in place saves the array', async () => {
			await DatedCopyTable.put('chunks', { title: 't', chunks: [Buffer.from([1, 2]), Buffer.from([3])] });
			await transaction(async (ctx) => {
				const rec = await DatedCopyTable.update('chunks', ctx);
				assert.strictEqual(hasChanges(rec), false);
				rec.chunks[0][0] = 9;
				assert.strictEqual(rec.getRecord().chunks[0][0], 1);
			});
			assert.deepStrictEqual(
				(await DatedCopyTable.get('chunks')).chunks.map((chunk) => [...chunk]),
				[[9, 2], [3]]
			);
		});
		it('an undeclared Date read through getProperty is a copy', async () => {
			await QA1955Table.put('undeclared-date', { title: 't', dynamicWhen: new Date(1000) });
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('undeclared-date', ctx);
				const when = rec.getProperty('dynamicWhen');
				assert.strictEqual(when, rec.getProperty('dynamicWhen'));
				when.setTime(2000);
				assert.strictEqual(rec.getRecord().dynamicWhen.getTime(), 1000);
			});
			assert.strictEqual((await QA1955Table.get('undeclared-date')).dynamicWhen.getTime(), 1000);
		});
		it('a reassigned edited value saves', async () => {
			await DatedCopyTable.put('reassign', { title: 't', when: new Date(1000) });
			await transaction(async (ctx) => {
				const rec = await DatedCopyTable.update('reassign', ctx);
				const when = rec.when;
				when.setTime(3000);
				rec.when = when;
			});
			assert.strictEqual((await DatedCopyTable.get('reassign')).when.getTime(), 3000);
			assert.strictEqual(auditedPatch('reassign').when.getTime(), 3000);
		});
		it('an array of dates writes nothing when read and is saved when an element is edited in place', async () => {
			await DatedCopyTable.put('dates', { title: 't', dates: [new Date(1000), new Date(2000)] });
			const versionBefore = DatedCopyTable.primaryStore.getEntry('dates').version;
			await transaction(async (ctx) => {
				const rec = await DatedCopyTable.update('dates', ctx);
				assert.strictEqual(rec.dates[0].getTime(), 1000);
				assert.strictEqual(hasChanges(rec), false);
			});
			assert.strictEqual(DatedCopyTable.primaryStore.getEntry('dates').version, versionBefore);
			await transaction(async (ctx) => {
				const rec = await DatedCopyTable.update('dates', ctx);
				rec.dates[0].setTime(5000);
			});
			const saved = await DatedCopyTable.get('dates');
			assert.deepStrictEqual(
				saved.dates.map((date) => date.getTime()),
				[5000, 2000]
			);
			assert.deepStrictEqual(
				auditedPatch('dates').dates.map((date) => date.getTime()),
				[5000, 2000]
			);
		});
	});

	describe('Blobs in the committed patch', () => {
		let BlobTable;
		before(() => {
			BlobTable = table({
				table: 'TrackedBlobs',
				database: 'test_qa1955',
				sealed: false,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
					{ name: 'data', type: 'Blob' },
				],
			});
		});
		async function waitUntil(probe, label) {
			const deadline = Date.now() + 5000;
			while (!probe()) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
				await delay(5);
			}
		}
		const bounded = (promise) =>
			Promise.race([promise, delay(5000).then(() => Promise.reject(new Error('transaction did not settle')))]);
		// commits once the blob's stream ends; asserts the commit was waiting on the blob's save before that
		async function assertCommitWaitsForBlob(id, assign) {
			await BlobTable.put(id, { title: 't' });
			const stream = new PassThrough();
			const blob = createBlob(stream, { saveBeforeCommit: true });
			let committed = false;
			const done = transaction(async (ctx) => {
				const rec = await BlobTable.update(id, ctx);
				assign(rec, blob);
			}).then(() => (committed = true));
			stream.write('first part, ');
			await waitUntil(() => isSaving(blob), 'the blob save to start');
			await delay(50);
			assert.strictEqual(committed, false, 'the commit waits for the blob');
			stream.end('last part');
			await bounded(done);
			return BlobTable.get(id);
		}

		it('a blob assigned as an own property is saved before the commit completes', async () => {
			const saved = await assertCommitWaitsForBlob('own-blob', (rec, blob) => (rec.extraBlob = blob));
			assert.strictEqual(await saved.extraBlob.text(), 'first part, last part');
		});
		it('a blob assigned to a declared attribute after the update is staged is saved before the commit completes', async () => {
			const saved = await assertCommitWaitsForBlob('declared-blob', (rec, blob) => (rec.data = blob));
			assert.strictEqual(await saved.data.text(), 'first part, last part');
		});
		it('a failed own-property blob fails the commit and its file is removed', async () => {
			await BlobTable.put('own-blob-fail', { title: 't' });
			const stream = new PassThrough();
			const blob = createBlob(stream, { saveBeforeCommit: true });
			const done = transaction(async (ctx) => {
				const rec = await BlobTable.update('own-blob-fail', ctx);
				rec.extraBlob = blob;
				rec.title = 'changed';
			});
			stream.write('partial');
			await waitUntil(() => isSaving(blob), 'the blob save to start');
			stream.destroy(new Error('stream failed'));
			await assert.rejects(bounded(done), /stream failed/);
			const saved = await BlobTable.get('own-blob-fail');
			assert.strictEqual(saved.title, 't');
			assert.strictEqual(saved.extraBlob, undefined);
			await waitUntil(() => !existsSync(getFilePathForBlob(blob)), 'the blob file to be removed');
		});
	});

	describe('Class fields on a Table subclass', () => {
		let SealedTable;
		before(() => {
			SealedTable = table({
				table: 'TrackedSealedFields',
				database: 'test_qa1955',
				audit: true,
				sealed: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
				],
			});
		});
		it('an unchanged class field is not written, so a sealed table accepts a patch', async () => {
			class WithField extends SealedTable {
				hits = 0;
			}
			await SealedTable.put('sealed', { title: 't' });
			await WithField.patch('sealed', { title: 'patched' });
			const saved = await SealedTable.get('sealed');
			assert.strictEqual(saved.title, 'patched');
			assert.strictEqual(saved.hits, undefined);
		});
		it('reading through a subclass with a class field writes nothing', async () => {
			class WithField extends SealedTable {
				hits = 0;
			}
			await SealedTable.put('sealed-read', { title: 't' });
			const versionBefore = SealedTable.primaryStore.getEntry('sealed-read').version;
			await transaction(async (ctx) => {
				const rec = await WithField.update('sealed-read', ctx);
				assert.strictEqual(rec.title, 't');
			});
			assert.strictEqual(SealedTable.primaryStore.getEntry('sealed-read').version, versionBefore);
		});
		it('a put-only source is not sent the default of an unchanged class field', async () => {
			const put = [];
			const PutSourced = table({
				table: 'TrackedPutSourcedFields',
				database: 'test_qa1955',
				sealed: false,
				attributes: [
					{ name: 'id', isPrimaryKey: true },
					{ name: 'title', type: 'String' },
				],
			});
			PutSourced.sourcedFrom({
				get(id) {
					return { id, title: 'from-source', tag: 'important' };
				},
				put(id, data) {
					put.push({ ...data });
				},
			});
			class WithField extends PutSourced {
				tag = 'default';
			}
			await PutSourced.get('put-only');
			await transaction(async (ctx) => {
				const rec = await WithField.update('put-only', ctx);
				rec.title = 'changed';
			});
			assert.strictEqual(put.length, 1);
			assert.strictEqual(put[0].title, 'changed');
			// the full record put is built from the loaded record when there is one (not on LMDB here)
			assert.notStrictEqual(put[0].tag, 'default');
			assert.strictEqual((await PutSourced.get('put-only')).tag, 'important');
		});
		it('addTo on an unchanged class field adds to the stored value', async () => {
			class WithField extends QA1955Table {
				hits = 0;
			}
			await QA1955Table.put('field-add', { title: 't', hits: 100 });
			await transaction(async (ctx) => {
				const rec = await WithField.update('field-add', ctx);
				rec.addTo('hits', 5);
			});
			assert.strictEqual((await QA1955Table.get('field-add')).hits, 105);
			const audited = [...QA1955Table.auditStore.getRange({ start: 1 })]
				.filter((entry) => entry.tableId === QA1955Table.tableId && entry.recordId === 'field-add')
				.map((entry) => entry.getValue(QA1955Table.primaryStore))
				.at(-1);
			assert.strictEqual(audited.hits.__op__, 'add');
		});
		it('an unchanged object class field is not written, so a sealed table accepts a patch', async () => {
			class WithField extends SealedTable {
				meta = { values: [1] };
			}
			await SealedTable.put('sealed-object', { title: 't' });
			const versionBefore = SealedTable.primaryStore.getEntry('sealed-object').version;
			await transaction(async (ctx) => {
				const rec = await WithField.update('sealed-object', ctx);
				assert.strictEqual(rec.title, 't');
			});
			assert.strictEqual(SealedTable.primaryStore.getEntry('sealed-object').version, versionBefore);
			await WithField.patch('sealed-object', { title: 'patched' });
			assert.strictEqual((await SealedTable.get('sealed-object')).title, 'patched');
		});
		it('a helper object class field is compared by identity, so a sealed table accepts a patch', async () => {
			class Helper {
				calls = 0;
			}
			class WithField extends SealedTable {
				helper = new Helper();
			}
			await SealedTable.put('sealed-helper', { title: 't' });
			await WithField.patch('sealed-helper', { title: 'patched' });
			const saved = await SealedTable.get('sealed-helper');
			assert.strictEqual(saved.title, 'patched');
			assert.strictEqual(saved.helper, undefined);
		});
		it('a field changed only through its pending changes keeps its baseline after the commit', () => {
			let record = { id: 'pending', hits: 100 };
			let changes;
			class Instance {
				hits = 0;
				getRecord() {
					return record;
				}
				getChanges() {
					return changes;
				}
			}
			const instance = new Instance();
			recordOwnBaseline(instance);
			changes = { hits: { __op__: 'add', value: 5 } };
			const patch = collapseChanges(instance, changes);
			assert.strictEqual(patch.hits.value, 5);
			releaseOwnBaseline(instance, patch); // as the commit does
			record = { id: 'pending', hits: 105 };
			changes = { title: 'v2' };
			assert.deepStrictEqual({ ...collapseChanges(instance, changes) }, { title: 'v2' });
		});
		it('an own object is committed as a copy, so a later in-place edit is still a change', () => {
			let record = { id: 'own-object' };
			class Instance {
				getRecord() {
					return record;
				}
				getChanges() {
					return undefined;
				}
			}
			const instance = new Instance();
			instance.meta = { value: 1 };
			const patch = collapseChanges(instance, undefined);
			assert.notStrictEqual(patch.meta, instance.meta);
			assert.deepStrictEqual(patch.meta, { value: 1 });
			record = { id: 'own-object', meta: patch.meta }; // committed
			assert.strictEqual(collapseChanges(instance, undefined), undefined);
			instance.meta.value = 2;
			assert.deepStrictEqual(collapseChanges(instance, undefined).meta, { value: 2 });
		});
		it('a function class field is not written, so a sealed table accepts a patch', async () => {
			class WithField extends SealedTable {
				format = () => 'x';
			}
			await SealedTable.put('sealed-function', { title: 't' });
			await WithField.patch('sealed-function', { title: 'patched' });
			assert.strictEqual((await SealedTable.get('sealed-function')).title, 'patched');
		});
		it('an own Date is committed as a copy, so a later in-place edit is still a change', () => {
			let record = { id: 'own-date' };
			class Instance {
				getRecord() {
					return record;
				}
				getChanges() {
					return undefined;
				}
			}
			const instance = new Instance();
			instance.when = new Date(1000);
			const patch = collapseChanges(instance, undefined);
			assert.notStrictEqual(patch.when, instance.when);
			record = { id: 'own-date', when: patch.when }; // committed
			assert.strictEqual(collapseChanges(instance, undefined), undefined);
			instance.when.setTime(2000);
			assert.strictEqual(collapseChanges(instance, undefined).when.getTime(), 2000);
		});
		it('an own object with a constructor data member or a null prototype is committed as a copy', () => {
			const withConstructorKey = { constructor: 'metadata', value: 1 };
			const withNullPrototype = Object.assign(Object.create(null), { value: 1 });
			for (const meta of [withConstructorKey, withNullPrototype]) {
				let record = { id: 'own-data' };
				class Instance {
					getRecord() {
						return record;
					}
					getChanges() {
						return undefined;
					}
				}
				const instance = new Instance();
				instance.meta = meta;
				const patch = collapseChanges(instance, undefined);
				assert.notStrictEqual(patch.meta, meta);
				record = { id: 'own-data', meta: patch.meta }; // committed
				assert.strictEqual(collapseChanges(instance, undefined), undefined);
				meta.value = 2;
				assert.strictEqual(collapseChanges(instance, undefined).meta.value, 2);
			}
		});
		it('a null-prototype class field changed in place is written', () => {
			const record = { id: 'null-prototype-field' };
			class Instance {
				counts = Object.create(null);
				getRecord() {
					return record;
				}
				getChanges() {
					return undefined;
				}
			}
			const instance = new Instance();
			recordOwnBaseline(instance);
			assert.strictEqual(collapseChanges(instance, undefined), undefined);
			instance.counts.a = 1;
			assert.strictEqual(collapseChanges(instance, undefined).counts.a, 1);
		});
		it('an own object holding a blob keeps the blob', async () => {
			await QA1955Table.put('own-object-blob', { title: 't' });
			await transaction(async (ctx) => {
				const rec = await QA1955Table.update('own-object-blob', ctx);
				rec.extra = { payload: createBlob(Buffer.from('blob content')) };
			});
			const saved = await QA1955Table.get('own-object-blob');
			assert.strictEqual(await saved.extra.payload.text(), 'blob content');
		});
		it('an object class field changed in place is written', async () => {
			class WithField extends QA1955Table {
				meta = { value: 0 };
			}
			await QA1955Table.put('field-object', { title: 't' });
			await transaction(async (ctx) => {
				const rec = await WithField.update('field-object', ctx);
				rec.meta.value = 1;
				rec.title = 'changed';
			});
			assert.strictEqual((await QA1955Table.get('field-object')).meta.value, 1);
		});
		it('a class field set back to its initial value after it was written is a change', () => {
			let record = { id: 'reset' };
			class Instance {
				hits = 0;
				getRecord() {
					return record;
				}
				getChanges() {
					return undefined;
				}
			}
			const instance = new Instance();
			recordOwnBaseline(instance);
			assert.strictEqual(collapseChanges(instance, undefined), undefined);
			instance.hits = 5;
			const patch = collapseChanges(instance, undefined);
			assert.deepStrictEqual({ ...patch }, { hits: 5 });
			// an aborted write keeps the baseline
			instance.hits = 0;
			assert.strictEqual(collapseChanges(instance, undefined), undefined);
			instance.hits = 5;
			releaseOwnBaseline(instance, patch); // as the commit does
			record = { id: 'reset', hits: 5 };
			instance.hits = 0;
			assert.deepStrictEqual({ ...collapseChanges(instance, undefined) }, { hits: 0 });
		});
		it('a class field the code changes is written on a non-sealed table', async () => {
			class WithField extends QA1955Table {
				hits = 0;
			}
			await QA1955Table.put('field-changed', { title: 't' });
			await transaction(async (ctx) => {
				const rec = await WithField.update('field-changed', ctx);
				rec.hits = 5;
			});
			assert.strictEqual((await QA1955Table.get('field-changed')).hits, 5);
		});
	});

	describe('Held lock', () => {
		it('saves an own dynamic property set alone on a held record', async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip(); // held locks are RocksDB-only
			await QA1955Table.put('held-own', { title: 'v1' });
			const held = await QA1955Table.lock('held-own', { hold: true, lease: 10_000 });
			held.extraHeld = 'kept';
			await held.save();
			await held.unlock();
			assert.strictEqual((await QA1955Table.get('held-own')).extraHeld, 'kept');
		});
		it('a failed commit keeps the class-field baselines of a held subclass record', async function () {
			if (process.env.HARPER_STORAGE_ENGINE === 'lmdb') this.skip();
			class WithField extends QA1955Table {
				hits = 0;
			}
			await QA1955Table.put('held-baseline', { title: 't', hits: 100 });
			await QA1955Table.put('held-baseline-anchor', { title: 'a' });
			let held;
			await transaction(async (ctx) => {
				const anchor = await WithField.update('held-baseline-anchor', ctx);
				held = await anchor.lock('held-baseline', { hold: true, lease: 10_000 });
			});
			let refuse = true;
			QA1955Table.setResidency(() => {
				if (refuse) throw new Error('residency refused');
			});
			try {
				held.hits = 5;
				await assert.rejects(async () => held.save(), /residency refused/);
				refuse = false;
				held.hits = 0; // back to its initial value, so untouched
				await held.save();
			} finally {
				QA1955Table.setResidency();
				await held.unlock();
			}
			assert.strictEqual((await QA1955Table.get('held-baseline')).hits, 100);
		});
	});
});
