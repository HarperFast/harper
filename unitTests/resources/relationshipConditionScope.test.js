require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

describe('A condition inside an OR decides which rows match, not which related records they select', function () {
	this.timeout(60000);
	let Parent;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const childrenAttribute = {
			name: 'children',
			elements: { type: 'ScopeChild', definition: {} },
			relationship: { from: 'childIds' },
		};
		const kidsAttribute = {
			name: 'kids',
			elements: { type: 'ScopeChild', definition: {} },
			relationship: { to: 'parentId' },
		};
		Parent = table({
			table: 'ScopeParent',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'childIds', elements: { type: 'ID' }, indexed: true },
				childrenAttribute,
				kidsAttribute,
			],
		});
		const Child = table({
			table: 'ScopeChild',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'label' },
				{ name: 'parentId', indexed: true },
			],
		});
		childrenAttribute.elements.definition.tableClass = Child;
		kidsAttribute.elements.definition.tableClass = Child;
		// p1 meets `name = a` and `label = y` only through different children, p2 through one, p3 not at all
		const children = [
			{ id: 'c1', name: 'a', label: 'x', parentId: 'p1' },
			{ id: 'c2', name: 'b', label: 'y', parentId: 'p1' },
			{ id: 'c3', name: 'a', label: 'y', parentId: 'p2' },
			{ id: 'c4', name: 'a', label: 'x', parentId: 'p3' },
		];
		for (const child of children) await Child.put(child);
		for (const id of ['p1', 'p2', 'p3'])
			await Parent.put({
				id,
				childIds: children.filter((child) => child.parentId === id).map((child) => child.id),
			});
	});

	async function search(query) {
		const results = Parent.search(query);
		const rows = [];
		for await (const row of results) rows.push(JSON.parse(JSON.stringify(row)));
		return rows;
	}

	for (const relationship of ['children', 'kids']) {
		describe(`through ${relationship}`, () => {
			const name = () => ({ attribute: [relationship, 'name'], value: 'a' });
			const label = () => ({ attribute: [relationship, 'label'], value: 'y' });
			const parents = () => ({ attribute: 'id', comparator: 'between', value: ['p1', 'p3'] });
			const select = ['id', { name: relationship, select: ['id'] }];
			const selected = (rows) =>
				rows.map((row) => [row.id, (row[relationship] ?? []).map((child) => child.id).sort()]).sort();

			it('lets a condition inside an OR be met by another related record, and selects by the AND scope', async () => {
				const orLabel = () => ({
					operator: 'or',
					conditions: [label(), { attribute: 'id', value: 'none' }],
				});
				for (const order of [
					[name, orLabel],
					[orLabel, name],
					[parents, name, orLabel],
					[parents, orLabel, name],
				]) {
					const conditions = order.map((condition) => condition());
					assert.deepStrictEqual(
						selected(await search({ conditions, select, enforceExecutionOrder: true })),
						[
							['p1', ['c1']],
							['p2', ['c3']],
						],
						JSON.stringify(conditions)
					);
				}
			});

			it('selects every related record of a row an OR admitted, whichever branch or outer condition leads', async () => {
				const all = [
					['p1', ['c1', 'c2']],
					['p2', ['c3']],
					['p3', ['c4']],
				];
				const nameB = () => ({ attribute: [relationship, 'name'], value: 'b' });
				const either =
					(...branches) =>
					() => ({ operator: 'or', conditions: branches.map((branch) => branch()) });
				const onlyP3 = () => ({ attribute: 'id', value: 'p3' });
				for (const [order, expected] of [
					[[either(label, onlyP3)], all],
					[[either(onlyP3, label)], all],
					[[either(nameB, name)], all],
					[[either(name, nameB)], all],
					[[either(onlyP3, label), parents], all],
					[[parents, either(label, onlyP3)], all],
					[
						[either(label, onlyP3), name],
						[
							['p1', ['c1']],
							['p2', ['c3']],
							['p3', ['c4']],
						],
					],
					[
						[name, either(onlyP3, label)],
						[
							['p1', ['c1']],
							['p2', ['c3']],
							['p3', ['c4']],
						],
					],
				]) {
					const conditions = () => order.map((condition) => condition());
					const forced = selected(await search({ conditions: conditions(), select, enforceExecutionOrder: true }));
					assert.deepStrictEqual(forced, expected, JSON.stringify(conditions()));
					assert.deepStrictEqual(selected(await search({ conditions: conditions(), select })), forced);
				}
			});
		});
	}
});

describe('A relationship condition that leads by estimate keeps the lead', function () {
	this.timeout(60000);

	it('does not hand it to a broader indexed condition, which would change which related record siblings meet', async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const kids = { name: 'kids', elements: { type: 'LeadChild', definition: {} }, relationship: { to: 'parentId' } };
		const Parent = table({
			table: 'LeadParent',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'group', indexed: true },
				{ name: 'b', indexed: true },
				kids,
			],
		});
		const Child = table({
			table: 'LeadChild',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'label' },
				{ name: 'parentId', indexed: true },
			],
		});
		kids.elements.definition.tableClass = Child;
		for (let i = 0; i < 60; i++) await Parent.put({ id: `p${i}`, group: 'g1', b: i === 1 ? 3 : 0 });
		await Child.put({ id: 'c1', parentId: 'p1', name: 'a', label: 'x' });
		await Child.put({ id: 'c2', parentId: 'p1', name: 'b', label: 'y' });
		const conditions = [
			{ attribute: 'group', value: 'g1' },
			{ attribute: ['kids', 'name'], value: 'a' },
			{ attribute: ['kids', 'label'], value: 'y' },
		];
		const { conditions: planned } = await Parent.search({ conditions, explain: true, allowFullScan: true });
		assert.deepStrictEqual(planned[0].attribute, ['kids', 'name']);
		// a group that leads with a local condition is not a relationship lead
		const grouped = [
			{ attribute: 'group', value: 'g1' },
			{ operator: 'and', conditions: [{ attribute: 'b', comparator: 'in', value: [3] }, conditions[1]] },
		];
		const rows = [];
		for await (const row of Parent.search({ conditions: grouped, allowFullScan: false })) rows.push(row.id);
		assert.deepStrictEqual(rows, ['p1']);
	});
});
