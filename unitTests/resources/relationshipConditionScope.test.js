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

			it('matches two AND conditions against one related record, whichever leads', async () => {
				const nested = () => ({ operator: 'and', conditions: [name(), label()] });
				for (const order of [
					[name, label],
					[label, name],
					[parents, name, label],
					[name, parents, label],
					[nested],
					[parents, nested],
				]) {
					const conditions = order.map((condition) => condition());
					for (const enforceExecutionOrder of [true, false])
						assert.deepStrictEqual(
							selected(await search({ conditions, select, enforceExecutionOrder })),
							[['p2', ['c3']]],
							JSON.stringify({ conditions, enforceExecutionOrder })
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

	it('stays ahead of a broader indexed condition, and the rows are the same wherever it sits', async () => {
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
				{ name: 'text' },
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
		for (let i = 0; i < 60; i++) await Parent.put({ id: `p${i}`, group: 'g1', b: i === 1 ? 3 : 0, text: 'needle' });
		await Child.put({ id: 'c1', parentId: 'p1', name: 'a', label: 'x' });
		await Child.put({ id: 'c2', parentId: 'p1', name: 'b', label: 'y' });
		const conditions = [
			{ attribute: 'group', value: 'g1' },
			{ attribute: ['kids', 'name'], value: 'a' },
			{ attribute: ['kids', 'label'], value: 'y' },
		];
		const { conditions: planned } = await Parent.search({ conditions, explain: true, allowFullScan: true });
		assert.deepStrictEqual(planned[0].attribute, ['kids', 'name']);
		const parents = [];
		for await (const row of Parent.search({ conditions, allowFullScan: true })) parents.push(row.id);
		assert.deepStrictEqual(parents, [], 'no single child meets both conditions');
		const grouped = [
			{ attribute: 'group', value: 'g1' },
			{ operator: 'and', conditions: [{ attribute: 'b', comparator: 'in', value: [3] }, conditions[1]] },
		];
		const rows = [];
		for await (const row of Parent.search({ conditions: grouped, allowFullScan: false })) rows.push(row.id);
		assert.deepStrictEqual(rows, ['p1']);
		const union = [
			{ attribute: 'group', value: 'g1' },
			{
				operator: 'or',
				conditions: [
					{ operator: 'and', conditions: [{ attribute: 'b', comparator: 'in', value: [3] }, conditions[2]] },
					conditions[1],
				],
			},
		];
		const unionRows = [];
		for await (const row of Parent.search({ conditions: union, allowFullScan: false })) unionRows.push(row.id);
		assert.deepStrictEqual(unionRows, ['p1']);
		const run = async (conditions, allowFullScan) => {
			const found = [];
			for await (const row of Parent.search({ conditions, allowFullScan })) found.push(row.id);
			return found;
		};
		const needle = { attribute: 'text', comparator: 'contains', value: 'needle' };
		assert.deepStrictEqual(
			await run(
				[
					{ attribute: 'group', value: 'g1' },
					{
						operator: 'and',
						conditions: [{ attribute: ['kids', 'label'], comparator: 'starts_with', value: 'y' }, needle],
					},
				],
				false
			),
			['p1']
		);
		assert.deepStrictEqual(
			await run(
				[
					{ attribute: 'b', comparator: 'in', value: [3] },
					{ operator: 'and', conditions: [conditions[1], { attribute: 'group', value: 'g1' }] },
					conditions[2],
				],
				true
			),
			[],
			'no single child meets both conditions, however they are grouped'
		);
	});
});

describe('AND-joined conditions on one relationship meet one related record whichever condition leads', function () {
	this.timeout(60000);
	let Parent;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const kids = { name: 'kids', elements: { type: 'SameChild', definition: {} }, relationship: { to: 'parentId' } };
		Parent = table({
			table: 'SameParent',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'group', indexed: true },
				{ name: 'text', indexed: true },
				kids,
			],
		});
		const Child = table({
			table: 'SameChild',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'name', indexed: true },
				{ name: 'label', indexed: true },
				{ name: 'parentId', indexed: true },
			],
		});
		kids.elements.definition.tableClass = Child;
		for (let i = 0; i < 60; i++) await Parent.put({ id: `p${i}`, group: 'common', text: 'needle' });
		// pw's children meet name=a and label=y separately; pm has one child that meets both
		await Parent.put({ id: 'pw', group: 'rare', text: 'needle' });
		await Parent.put({ id: 'pm', group: 'rare', text: 'needle' });
		await Child.put({ id: 'w1', parentId: 'pw', name: 'a', label: 'x' });
		await Child.put({ id: 'w2', parentId: 'pw', name: 'b', label: 'y' });
		await Child.put({ id: 'm1', parentId: 'pm', name: 'a', label: 'y' });
	});

	const name = () => ({ attribute: ['kids', 'name'], value: 'a' });
	const label = () => ({ attribute: ['kids', 'label'], value: 'y' });
	const rare = () => ({ attribute: 'group', value: 'rare' });
	const needle = () => ({ attribute: 'text', comparator: 'contains', value: 'needle' });
	const localGroup = () => ({ operator: 'and', conditions: [rare(), needle()] });
	const relationshipGroup = () => ({ operator: 'and', conditions: [name(), label()] });
	const select = ['id', { name: 'kids', select: ['id'] }];
	async function search(conditions, extra = {}) {
		const rows = [];
		for await (const row of Parent.search({ conditions, select, ...extra }))
			rows.push([row.id, (row.kids ?? []).map((kid) => kid.id).sort()]);
		return rows.sort();
	}
	const permutations = (items) =>
		items.length < 2
			? [items]
			: items.flatMap((item, i) => permutations(items.filter((_, j) => j !== i)).map((rest) => [item, ...rest]));

	it('selects only the parent whose one child meets both conditions, in every order', async () => {
		for (const order of permutations([name, label, localGroup])) {
			for (const enforceExecutionOrder of [true, false]) {
				const conditions = order.map((condition) => condition());
				assert.deepStrictEqual(
					await search(conditions, { enforceExecutionOrder }),
					[['pm', ['m1']]],
					JSON.stringify({ conditions, enforceExecutionOrder })
				);
			}
		}
	});

	it('does not widen a query whose local group estimates finite (the group would otherwise lead)', async () => {
		const conditions = [name(), label(), localGroup()];
		const { conditions: planned } = await Parent.search({ conditions, explain: true, allowFullScan: true });
		assert.ok(planned.length > 0);
		assert.deepStrictEqual(await search(conditions), [['pm', ['m1']]]);
		const ids = [];
		for await (const row of Parent.search({ conditions, select: ['id'], allowFullScan: true })) ids.push(row.id);
		assert.deepStrictEqual(ids, ['pm']);
	});

	it('applies the rule to conditions in a nested AND group and in several groups of one AND', async () => {
		const both = [['pm', ['m1']]];
		for (const conditions of [
			[rare(), relationshipGroup()],
			[relationshipGroup(), rare()],
			[name(), { operator: 'and', conditions: [label(), rare()] }],
			[{ operator: 'and', conditions: [label(), rare()] }, name()],
			[
				{ operator: 'and', conditions: [name(), rare()] },
				{ operator: 'and', conditions: [label(), needle()] },
			],
		]) {
			assert.deepStrictEqual(
				await search(conditions, { enforceExecutionOrder: true }),
				both,
				JSON.stringify(conditions)
			);
		}
	});

	it('applies the rule inside an AND that is a branch of an OR, without restricting that branch', async () => {
		const onlyP1 = () => ({ attribute: 'id', value: 'p1' });
		for (const branches of [
			[relationshipGroup, onlyP1],
			[onlyP1, relationshipGroup],
		]) {
			assert.deepStrictEqual(
				await search([{ operator: 'or', conditions: branches.map((branch) => branch()) }], {
					enforceExecutionOrder: true,
				}),
				[
					['p1', []],
					['pm', ['m1']],
				]
			);
		}
	});

	it('lets a branch of an OR be met by another related record than the AND conditions around it', async () => {
		const orLabel = () => ({ operator: 'or', conditions: [label(), { attribute: 'id', value: 'none' }] });
		for (const order of [
			[name, orLabel],
			[orLabel, name],
			[name, localGroup, orLabel],
		]) {
			assert.deepStrictEqual(
				await search(
					order.map((condition) => condition()),
					{ enforceExecutionOrder: true }
				),
				[
					['pm', ['m1']],
					['pw', ['w1']],
				],
				order.map((condition) => condition.name).join()
			);
		}
	});
});
