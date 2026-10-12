const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { transformForSelect } = require('#src/resources/Resource');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');

describe('nested select over missing relationship values', function () {
	let Parent, Child;
	const positional = ['name'];
	positional.asArray = true;
	const projections = [
		{ name: 'scalar', select: 'name', present: 'child' },
		{ name: 'object', select: ['name'], present: { name: 'child' } },
		{ name: 'positional array', select: positional, present: ['child'] },
	];

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		Child = table({
			database: 'nested_select_missing',
			table: 'Child',
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'name', type: 'String' },
			],
		});
		Parent = table({
			database: 'nested_select_missing',
			table: 'Parent',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'childId', type: 'Int' },
				{ name: 'childIds', elements: { type: 'Int' } },
				{ name: 'number', type: 'Int' },
				{ name: 'text', type: 'String' },
				{ name: 'flag', type: 'Boolean' },
				{
					name: 'child',
					type: 'Child',
					relationship: { from: 'childId' },
					definition: { tableClass: Child },
				},
				{
					name: 'children',
					elements: { type: 'Child', definition: { tableClass: Child } },
					relationship: { from: 'childIds' },
				},
			],
		});
		await Child.put({ id: 1, name: 'child' });
		await Parent.put({ id: 'absent' });
		await Parent.put({ id: 'null-foreign-key', childId: null });
		await Parent.put({ id: 'orphan', childId: 0 });
		await Parent.put({ id: 'present', childId: 1 });
		await Parent.put({ id: 'mixed', childIds: [1, 0] });
		await Parent.put({ id: 'primitives-falsy', number: 0, text: '', flag: false });
		await Parent.put({ id: 'primitives-truthy', number: 1, text: 'value', flag: true });
	});

	after(async function () {
		await Parent?.dropTable();
		await Child?.dropTable();
	});

	for (const projection of projections) {
		for (const [id, expected] of [
			['absent', undefined],
			['null-foreign-key', null],
			['orphan', undefined],
		]) {
			it(`preserves ${id} native relationship values in a ${projection.name} projection`, async function () {
				const target = new RequestTarget();
				target.id = id;
				target.select = ['id', { name: 'child', select: projection.select }];
				const row = await Parent.get(target);
				assert.deepStrictEqual(row, { id, child: expected });
			});
		}
		it(`projects a present native relationship in a ${projection.name} projection`, async function () {
			const target = new RequestTarget();
			target.id = 'present';
			target.select = ['id', { name: 'child', select: projection.select }];
			assert.deepStrictEqual(await Parent.get(target), { id: 'present', child: projection.present });
		});
		it(`preserves missing entries in a ${projection.name} relationship array`, async function () {
			const target = new RequestTarget();
			target.id = 'mixed';
			target.select = ['id', { name: 'children', select: projection.select }];
			assert.deepStrictEqual(await Parent.get(target), {
				id: 'mixed',
				children: [projection.present, undefined],
			});
		});

		for (const value of [undefined, null]) {
			it(`preserves ${value} and its promise in a ${projection.name} transform`, async function () {
				const transform = transformForSelect(projection.select, Child);
				assert.strictEqual(transform(value), value);
				assert.strictEqual(await transform(Promise.resolve(value)), value);
			});
		}
	}

	it('preserves forceNulls on a missing nested relationship', async function () {
		const target = new RequestTarget();
		target.id = 'orphan';
		target.select = ['id', { name: 'child', select: ['name'] }];
		target.select.forceNulls = true;
		assert.deepStrictEqual(await Parent.get(target), { id: 'orphan', child: null });
	});

	it('passes primitive selected values through before constructing a nested transform', async function () {
		for (const expected of [
			{ id: 'primitives-falsy', number: 0, text: '', flag: false },
			{ id: 'primitives-truthy', number: 1, text: 'value', flag: true },
		]) {
			const target = new RequestTarget();
			target.id = expected.id;
			target.select = ['id', ...['number', 'text', 'flag'].map((name) => ({ name, select: ['name'] }))];
			assert.deepStrictEqual(await Parent.get(target), expected);
		}
	});
});
