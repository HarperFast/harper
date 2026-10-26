const assert = require('node:assert');
const { table } = require('#src/resources/databases');
const { transaction } = require('#src/resources/transaction');
const { collapseData, hasChanges } = require('#src/resources/tracked');
const { setupTestDBPath } = require('../testUtils');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

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
				// a write from another transaction lands before this one commits
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
	});
});
