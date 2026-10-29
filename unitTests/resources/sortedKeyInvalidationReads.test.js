require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { searchByIndex, filterByType } = require('#src/resources/search');
const { transaction } = require('#src/resources/transaction');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { INVALIDATED } = require('#src/resources/Table');

describe('Primary-key filter and key-stream reads over null cache invalidations', function () {
	this.timeout(20_000);
	const database = 'test_sorted_key_invalidation';

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
	});

	async function collectRows(iterable) {
		const rows = [];
		for await (const row of iterable) rows.push({ ...row });
		return rows;
	}

	async function invalidateNull(TableClass, id) {
		const context = {};
		await transaction(context, async () => {
			const resource = await TableClass.getResource(id, context, { ensureLoaded: false });
			resource._writeInvalidate(id);
		});
		const entry = TableClass.primaryStore.getEntry(id);
		assert.ok(entry.metadataFlags & INVALIDATED, `premise: ${id} is invalidated`);
		assert.strictEqual(entry.value, null, `premise: ${id} has no record`);
		return entry;
	}

	function cachingTable(name, attributes = []) {
		const Rows = table({
			database,
			table: name,
			audit: true,
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'body', type: 'String' }, ...attributes],
		});
		const source = { loads: 0 };
		Rows.sourcedFrom({
			get(id) {
				source.loads++;
				return { id, body: 'beta' };
			},
		});
		return { Rows, source };
	}

	it('sorts primary-key in and ne results', async () => {
		const Rows = table({
			database,
			table: 'PrimaryKeyFilterSort',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'body', type: 'String' },
				{ name: 'rank', type: 'Int' },
			],
		});
		await Rows.put('a', { id: 'a', body: 'zzz', rank: 30 });
		await Rows.put('b', { id: 'b', body: 'aaa', rank: 10 });
		await Rows.put('c', { id: 'c', body: 'mmm', rank: 20 });

		const inSorted = await collectRows(
			Rows.search({
				conditions: [{ attribute: 'id', comparator: 'in', value: ['a', 'b', 'c'] }],
				sort: { attribute: 'body' },
			})
		);
		const neSorted = await collectRows(
			Rows.search({ conditions: [{ attribute: 'id', comparator: 'ne', value: 'none' }], sort: { attribute: 'rank' } })
		);
		assert.deepStrictEqual(
			inSorted.map((row) => row.id),
			['b', 'c', 'a']
		);
		assert.deepStrictEqual(
			neSorted.map((row) => row.id),
			['b', 'c', 'a']
		);
	});

	it('yields entries, including invalidated ones, from every primary-key scan', async () => {
		const { Rows } = cachingTable('PrimaryKeyScanEntries');
		await Rows.put('local', { id: 'local', body: 'alpha' });
		await Rows.put('stub', { id: 'stub', body: 'old' });
		await invalidateNull(Rows, 'stub');
		const readTxn = Rows._readTxnForContext({});
		for (const condition of [
			{ attribute: 'id', comparator: 'between', value: ['local', 'stub'] },
			{ attribute: 'id', comparator: 'in', value: ['local', 'stub', 'missing'] },
			{ attribute: 'id', comparator: 'ne', value: 'none' },
		]) {
			const results = searchByIndex(condition, readTxn, false, Rows);
			assert.strictEqual(results.hasEntries, true);
			const synchronous = [];
			for (const entry of results) synchronous.push(entry);
			const asynchronous = [];
			for await (const entry of searchByIndex(condition, readTxn, false, Rows)) asynchronous.push(entry);
			for (const entries of [synchronous, asynchronous]) {
				assert.deepStrictEqual(
					entries.map((entry) => entry.key),
					['local', 'stub'],
					condition.comparator
				);
				assert.strictEqual(entries[0].value.body, 'alpha');
				assert.ok(entries[1].metadataFlags & INVALIDATED);
			}
		}
	});

	it('revalidates an invalidated row matched by a primary-key filter', async () => {
		const { Rows, source } = cachingTable('PrimaryKeyFilterNullInvalidation');
		await Rows.put('local', { id: 'local', body: 'alpha' });
		await Rows.put('stub', { id: 'stub', body: 'old' });

		await invalidateNull(Rows, 'stub');
		const between = await collectRows(
			Rows.search({ conditions: [{ attribute: 'id', comparator: 'between', value: ['local', 'stub'] }] })
		);
		assert.deepStrictEqual(
			between.map((row) => row.id),
			['local', 'stub']
		);
		assert.strictEqual(source.loads, 1);

		const conditions = [{ attribute: 'id', comparator: 'in', value: ['local', 'stub', 'missing'] }];
		await invalidateNull(Rows, 'stub');
		source.loads = 0;
		assert.deepStrictEqual(await collectRows(Rows.search({ conditions }, { replicateFrom: false })), [
			{ id: 'local', body: 'alpha' },
		]);
		assert.strictEqual(source.loads, 0);

		assert.deepStrictEqual(await collectRows(Rows.search({ conditions })), [
			{ id: 'local', body: 'alpha' },
			{ id: 'stub', body: 'beta' },
		]);
		assert.strictEqual(source.loads, 1);
	});

	it('keeps an invalidated row when every sibling condition is on the primary key', async () => {
		const { Rows, source } = cachingTable('PrimaryKeySiblingInvalidation');
		await Rows.put('a', { id: 'a', body: 'alpha' });
		await Rows.put('b', { id: 'b', body: 'bravo' });
		await Rows.put('c', { id: 'c', body: 'charlie' });
		const leads = [
			{ attribute: 'id', comparator: 'in', value: ['a', 'c'] },
			{ attribute: 'id', comparator: 'between', value: ['a', 'c'] },
		];
		for (const lead of leads) {
			await invalidateNull(Rows, 'c');
			source.loads = 0;
			const rows = await collectRows(
				Rows.search({
					enforceExecutionOrder: true,
					conditions: [lead, { attribute: 'id', comparator: 'ne', value: 'b' }],
				})
			);
			assert.deepStrictEqual(
				rows,
				[
					{ id: 'a', body: 'alpha' },
					{ id: 'c', body: 'beta' },
				],
				lead.comparator
			);
			assert.strictEqual(source.loads, 1);
		}

		for (const query of [
			{ conditions: [leads[0], { attribute: 'body', comparator: 'ne', value: 'bravo' }] },
			{ conditions: [leads[0]], rowFilter: () => true },
		]) {
			await invalidateNull(Rows, 'c');
			source.loads = 0;
			assert.deepStrictEqual(await collectRows(Rows.search({ enforceExecutionOrder: true, ...query })), [
				{ id: 'a', body: 'alpha' },
			]);
			assert.strictEqual(source.loads, 0);
		}
	});

	it('sorts an invalidated row in a key stream', async () => {
		const Links = table({
			database,
			table: 'RowLinks',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'rowId', type: 'String', indexed: true },
			],
		});
		const { Rows, source } = cachingTable('OrKeyStreamSortedNullInvalidation', [
			{
				name: 'links',
				relationship: { to: 'rowId' },
				elements: { type: 'RowLinks', definition: { tableClass: Links } },
			},
		]);
		await Rows.put('local', { id: 'local', body: 'alpha' });
		await Rows.put('stub', { id: 'stub', body: 'old' });
		await Links.put('l-stub', { id: 'l-stub', rowId: 'stub' });
		await Links.put('l-local', { id: 'l-local', rowId: 'local' });
		const conditions = [
			{ attribute: ['links', 'id'], comparator: 'equals', value: 'l-stub' },
			{ attribute: ['links', 'id'], comparator: 'equals', value: 'l-local' },
		];

		await invalidateNull(Rows, 'stub');
		const unsorted = await collectRows(Rows.search({ operator: 'or', conditions }));
		assert.deepStrictEqual(
			unsorted.map((row) => row.id),
			['stub', 'local']
		);
		assert.strictEqual(source.loads, 1);

		const stubEntry = await invalidateNull(Rows, 'stub');
		assert.ok(stubEntry.version > Rows.primaryStore.getEntry('local').version);
		source.loads = 0;
		const sorted = await collectRows(
			Rows.search({ operator: 'or', conditions, sort: { attribute: '$updatedtime', descending: true } })
		);
		assert.deepStrictEqual(
			sorted.map((row) => row.id),
			['stub', 'local']
		);
		assert.strictEqual(source.loads, 1);
	});

	it('compares a composite primary key whole when a primary-key sibling filters it', async () => {
		const Rows = table({
			database,
			table: 'CompositeKeySiblings',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'n' }],
		});
		await Rows.put([2, 240], { id: [2, 240], n: 1 });
		await Rows.put([3, 1], { id: [3, 1], n: 2 });
		for (const lead of [
			{ attribute: 'id', comparator: 'ne', value: 'excluded' },
			{ attribute: 'id', comparator: 'between', value: [[1], [9]] },
		]) {
			const rows = await collectRows(
				Rows.search({
					allowFullScan: true,
					enforceExecutionOrder: true,
					conditions: [lead, { attribute: 'id', comparator: 'prefix', value: [2] }],
				})
			);
			assert.deepStrictEqual(
				rows.map((row) => row.id),
				[[2, 240]],
				lead.comparator
			);
		}
	});

	it('limits a selected many-to-many relationship to the children a primary-key condition matched', async () => {
		const Child = table({
			database,
			table: 'JoinedChild',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
			],
		});
		const Parent = table({
			database,
			table: 'JoinedParent',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'childIds', elements: { type: 'ID' }, indexed: true },
				{
					name: 'children',
					elements: { type: 'JoinedChild', definition: { tableClass: Child } },
					relationship: { from: 'childIds' },
				},
			],
		});
		for (let i = 1; i <= 4; i++) await Child.put('c' + i, { id: 'c' + i, name: 'child ' + i });
		await Parent.put('p1', { id: 'p1', childIds: ['c1', 'c2'] });
		await Parent.put('p2', { id: 'p2', childIds: ['c3'] });
		await Parent.put('p3', { id: 'p3', childIds: ['c2', 'c4'] });
		for (const [condition, expected] of [
			[{ value: 'c2' }, { p1: ['c2'], p3: ['c2'] }],
			[{ comparator: 'lt', value: 'c2' }, { p1: ['c1'] }],
			[
				{ comparator: 'in', value: ['c2', 'c3'] },
				{ p1: ['c2'], p2: ['c3'], p3: ['c2'] },
			],
			[
				{ comparator: 'ne', value: 'c2' },
				{ p1: ['c1'], p2: ['c3'], p3: ['c4'] },
			],
		]) {
			const selected = {};
			for await (const parent of Parent.search({
				conditions: [{ attribute: ['children', 'id'], ...condition }],
				select: ['id', 'children'],
			}))
				selected[parent.id] = (await parent.children).map((child) => child.id);
			assert.deepStrictEqual(selected, expected, condition.comparator ?? 'equals');
		}
	});

	it('joins through an invalidated child by key, unless another joined condition reads its record', async () => {
		const Child = table({
			database,
			table: 'InvalidatedJoinedChild',
			audit: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', type: 'String' },
			],
		});
		const Parent = table({
			database,
			table: 'InvalidatedJoinedParent',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'childIds', elements: { type: 'ID' }, indexed: true },
				{
					name: 'children',
					elements: { type: 'InvalidatedJoinedChild', definition: { tableClass: Child } },
					relationship: { from: 'childIds' },
				},
			],
		});
		for (let i = 1; i <= 3; i++) await Child.put('c' + i, { id: 'c' + i, name: 'child ' + i });
		await Parent.put('p1', { id: 'p1', childIds: ['c1', 'c2'] });
		await Parent.put('p2', { id: 'p2', childIds: ['c3'] });
		await invalidateNull(Child, 'c2');
		const byId = { attribute: ['children', 'id'], comparator: 'in', value: ['c2', 'c3'] };
		const parentIds = async (conditions) =>
			(await collectRows(Parent.search({ enforceExecutionOrder: true, conditions, select: ['id'] })))
				.map((row) => row.id)
				.sort();
		assert.deepStrictEqual(await parentIds([byId]), ['p1', 'p2']);
		assert.deepStrictEqual(await parentIds([byId, { attribute: ['children', 'name'], comparator: 'ne', value: 'x' }]), [
			'p2',
		]);
		assert.deepStrictEqual(await parentIds([byId, { attribute: ['children', 'id'], comparator: 'ne', value: 'x' }]), [
			'p1',
			'p2',
		]);
		assert.deepStrictEqual(await parentIds([byId, { attribute: ['children', 'id'], comparator: 'ne', value: 'c2' }]), [
			'p2',
		]);

		const readTxn = Parent._readTxnForContext({});
		const scan = (filters) => {
			const filtered = {};
			const results = searchByIndex(byId, readTxn, false, Parent, { filtered });
			filtered.children.filters = filters;
			return results;
		};
		const keyNot = (value) => filterByType({ attribute: 'id', comparator: 'ne', value }, Child, {}, null, true);
		for (const [filters, expected] of [
			[[(record) => record.name !== 'x'], ['p2']],
			[[keyNot('x')], ['p1', 'p2']],
			[[keyNot('c2')], ['p2']],
		]) {
			const synchronous = [];
			for (const id of scan(filters)) synchronous.push(id);
			const asynchronous = [];
			for await (const id of scan(filters)) asynchronous.push(id);
			assert.deepStrictEqual(synchronous, expected);
			assert.deepStrictEqual(asynchronous, expected);
		}
	});
});
