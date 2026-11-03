require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const limitedUser = {
	role: {
		permission: {
			same_record: {
				tables: {
					Brand: { read: true },
					Product: {
						read: true,
						attribute_permissions: [
							{ attribute_name: 'id', read: true },
							{ attribute_name: 'brandId', read: true },
							{ attribute_name: 'name', read: true },
						],
					},
					Department: { read: true },
					Employee: { read: true },
				},
			},
		},
	},
};

describe('A relationship condition is existential; `relationship[conditions]` is met by one related record', function () {
	this.timeout(60000);
	let Brand, Product, Employee;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const products = {
			name: 'products',
			elements: { type: 'Product', definition: {} },
			relationship: { to: 'brandId' },
		};
		const departments = {
			name: 'departments',
			elements: { type: 'Department', definition: {} },
			relationship: { from: 'departmentIds' },
		};
		const employees = {
			name: 'employees',
			elements: { type: 'Employee', definition: {} },
			relationship: { to: 'departmentId' },
		};
		const brand = { name: 'brand', type: 'Brand', definition: {}, relationship: { from: 'brandId' } };
		Brand = table({
			table: 'Brand',
			database: 'same_record',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'group', indexed: true },
				{ name: 'departmentIds', elements: { type: 'ID' }, indexed: true },
				products,
				departments,
			],
		});
		Product = table({
			table: 'Product',
			database: 'same_record',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'brandId', indexed: true },
				{ name: 'name', type: 'String', indexed: true },
				{ name: 'price', type: 'Int', indexed: true },
				{ name: 'color', type: 'String' },
				brand,
			],
		});
		const Department = table({
			table: 'Department',
			database: 'same_record',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'name', indexed: true }, employees],
		});
		Employee = table({
			table: 'Employee',
			database: 'same_record',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'departmentId', indexed: true },
				{ name: 'tag', indexed: true },
				{ name: 'level', type: 'Int', indexed: true },
				{ name: 'role', type: 'String' },
			],
		});
		products.elements.definition.tableClass = Product;
		departments.elements.definition.tableClass = Department;
		employees.elements.definition.tableClass = Employee;
		brand.definition.tableClass = Brand;
		for (let i = 0; i < 30; i++) await Brand.put({ id: `filler${i}`, group: 'g' });
		await Brand.put({ id: 'both', group: 'g', departmentIds: ['d-split'] });
		await Brand.put({ id: 'keyboard', group: 'g', departmentIds: ['d-whole'] });
		await Brand.put({ id: 'cable-split', group: 'g', departmentIds: [] });
		await Brand.put({ id: 'cable-whole', group: 'g', departmentIds: [] });
		for (const product of [
			{ id: 'k1', brandId: 'both', name: 'Keyboard', price: 10, color: 'black' },
			{ id: 'm1', brandId: 'both', name: 'Mouse', price: 20, color: 'white' },
			{ id: 'k2', brandId: 'keyboard', name: 'Keyboard', price: 40, color: 'white' },
			{ id: 'c1', brandId: 'cable-split', name: 'Cable', price: 10, color: 'black' },
			{ id: 'o1', brandId: 'cable-split', name: 'Other', price: 40, color: 'black' },
			{ id: 'c2', brandId: 'cable-whole', name: 'Cable', price: 35, color: 'black' },
		])
			await Product.put(product);
		await Department.put({ id: 'd-split', name: 'Split' });
		await Department.put({ id: 'd-whole', name: 'Whole' });
		await Employee.put({ id: 'e1', departmentId: 'd-split', tag: 't', level: 1, role: 'junior' });
		await Employee.put({ id: 'e2', departmentId: 'd-split', tag: 'x', level: 5, role: 'lead' });
		await Employee.put({ id: 'e3', departmentId: 'd-whole', tag: 't', level: 4, role: 'lead' });
	});

	const name = (value) => () => ({ attribute: ['products', 'name'], value });
	const local = () => ({ attribute: 'group', value: 'g' });
	const group =
		(operator, ...conditions) =>
		() => ({ attribute: 'products', operator, conditions });
	const permutations = (items) =>
		items.length < 2
			? [items]
			: items.flatMap((item, i) => permutations(items.filter((_, j) => j !== i)).map((rest) => [item, ...rest]));
	const productSelect = ['id', { name: 'products', select: ['id'] }];
	async function rows(query) {
		const found = [];
		for await (const row of Brand.search(query))
			found.push([row.id, (row.products ?? []).map((product) => product.id)]);
		return found.sort();
	}
	function syncRows(query) {
		return Array.from(Brand.search(query))
			.map((row) => [row.id, (row.products ?? []).map((product) => product.id)])
			.sort();
	}
	async function everyOrder(members, expected, extra = {}) {
		for (const order of permutations(members)) {
			for (const enforceExecutionOrder of [true, false]) {
				const query = () => ({
					conditions: order.map((condition) => condition()),
					select: productSelect,
					enforceExecutionOrder,
					...extra,
				});
				const label = JSON.stringify(query());
				assert.deepStrictEqual(await rows(query()), expected, label);
				assert.deepStrictEqual(syncRows(query()), expected, `sync ${label}`);
			}
		}
	}

	it('matches a brand having a Keyboard and a Mouse, whichever condition leads', async () => {
		await everyOrder([name('Keyboard'), name('Mouse'), local], [['both', ['k1', 'm1']]]);
	});

	it('matches no brand for one product named both Keyboard and Mouse', async () => {
		const sameProduct = group(
			undefined,
			{ attribute: 'name', value: 'Keyboard' },
			{ attribute: 'name', value: 'Mouse' }
		);
		await everyOrder([sameProduct, local], []);
		await everyOrder([sameProduct, name('Keyboard')], []);
	});

	it('matches only a brand with one product that is a Cable and costs at least 30', async () => {
		const cable = { attribute: 'name', value: 'Cable' };
		const pricey = { attribute: 'price', comparator: 'ge', value: 30 };
		await everyOrder([group(undefined, cable, pricey), local], [['cable-whole', ['c2']]]);
		await everyOrder([group(undefined, cable, pricey), local], [['cable-whole', ['c2']]], { allowFullScan: false });
		await everyOrder(
			[name('Cable'), () => ({ attribute: ['products', 'price'], comparator: 'ge', value: 30 }), local],
			[
				['cable-split', ['c1', 'o1']],
				['cable-whole', ['c2']],
			]
		);
		const planned = (
			await Brand.search({
				conditions: [local(), group(undefined, cable, pricey)()],
				explain: true,
				allowFullScan: false,
			})
		).conditions;
		assert.deepStrictEqual(planned[0].attribute, ['products'], 'the group drives an index scan');
	});

	it('parses the same-record form from REST and coerces its values on the related table', async () => {
		assert.deepStrictEqual(await rows(new RequestTarget('?products[name=Cable&price=ge=30]&select(id,products{id})')), [
			['cable-whole', ['c2']],
		]);
		assert.deepStrictEqual(
			await rows(new RequestTarget('?products.name=Keyboard&products.name=Mouse&select(id,products{id})')),
			[['both', ['k1', 'm1']]]
		);
		assert.deepStrictEqual(await rows(new RequestTarget('?products[name=Keyboard&name=Mouse]&select(id,)')), []);
	});

	it('supports OR and nested groups inside a same-record group, which select only what the whole group matches', async () => {
		await everyOrder(
			[group('or', { attribute: 'name', value: 'Mouse' }, { attribute: 'price', comparator: 'ge', value: 40 }), local],
			[
				['both', ['m1']],
				['cable-split', ['o1']],
				['keyboard', ['k2']],
			]
		);
		const either = {
			operator: 'or',
			conditions: [
				{ attribute: 'name', value: 'Cable' },
				{ attribute: 'name', value: 'Keyboard' },
			],
		};
		await everyOrder(
			[group(undefined, either, { attribute: 'price', comparator: 'ge', value: 30 }), local],
			[
				['cable-whole', ['c2']],
				['keyboard', ['k2']],
			],
			{ allowFullScan: false }
		);
		await everyOrder(
			[group(undefined, { operator: 'and', conditions: [either, { attribute: 'color', value: 'black' }] }), local],
			[
				['both', ['k1']],
				['cable-split', ['c1']],
				['cable-whole', ['c2']],
			]
		);
	});

	it('selects the products meeting any separate condition, including through a leading join', async () => {
		const pricey = () => ({ attribute: ['products', 'price'], comparator: 'ge', value: 20 });
		await everyOrder(
			[name('Keyboard'), pricey],
			[
				['both', ['k1', 'm1']],
				['keyboard', ['k2']],
			]
		);
		const cableGroup = group(undefined, { attribute: 'name', value: 'Cable' }, { attribute: 'color', value: 'black' });
		await everyOrder(
			[cableGroup, () => ({ attribute: ['products', 'price'], comparator: 'ge', value: 40 })],
			[['cable-split', ['c1', 'o1']]]
		);
	});

	it('binds one related record per group at each hop it names, and stays existential below it', async () => {
		const brands = async (conditions) => (await rows({ conditions, select: ['id'] })).map(([id]) => id);
		const tag = { attribute: 'tag', value: 't' };
		const senior = { attribute: 'level', comparator: 'ge', value: 3 };
		const departmentsGroup = (...conditions) => ({ attribute: 'departments', conditions });
		assert.deepStrictEqual(await brands([departmentsGroup({ attribute: 'employees', conditions: [tag, senior] })]), [
			'keyboard',
		]);
		assert.deepStrictEqual(
			await brands([
				departmentsGroup(
					{ attribute: ['employees', 'tag'], value: 't' },
					{ attribute: ['employees', 'level'], comparator: 'ge', value: 3 }
				),
			]),
			['both', 'keyboard']
		);
		assert.deepStrictEqual(await brands([{ attribute: ['departments', 'employees'], conditions: [tag, senior] }]), [
			'keyboard',
		]);
		assert.deepStrictEqual(await rows(new RequestTarget('?departments[employees[tag=t&level=ge=3]]&select(id,)')), [
			['keyboard', []],
		]);
		assert.deepStrictEqual(
			await brands([
				departmentsGroup({ attribute: 'name', value: 'Split' }, { attribute: 'employees', conditions: [tag, senior] }),
			]),
			[]
		);
		const contexts = [];
		const readTxnForContext = Employee._readTxnForContext;
		Employee._readTxnForContext = function (context) {
			contexts.push(context);
			return readTxnForContext.call(this, context);
		};
		try {
			const unindexedRolePath = { attribute: ['employees', 'role'], value: 'lead' };
			for (const [TableClass, conditions, expected] of [
				[
					Product,
					[
						{
							attribute: ['brand', 'departments'],
							conditions: [{ attribute: 'name', value: 'Split' }, unindexedRolePath],
						},
					],
					['k1', 'm1'],
				],
				[
					Product,
					[
						{
							attribute: 'brand',
							conditions: [departmentsGroup({ attribute: 'name', value: 'Split' }, unindexedRolePath)],
						},
					],
					['k1', 'm1'],
				],
				[
					Product,
					[
						{
							attribute: ['brand', 'departments'],
							conditions: [
								{
									operator: 'or',
									conditions: [
										{ attribute: 'name', value: 'Split' },
										{ attribute: 'name', value: 'Whole' },
									],
								},
								unindexedRolePath,
							],
						},
					],
					['k1', 'k2', 'm1'],
				],
				[
					Product,
					[
						{
							attribute: ['brand', 'departments'],
							operator: 'or',
							conditions: [{ attribute: 'name', value: 'Whole' }, unindexedRolePath],
						},
					],
					['k1', 'k2', 'm1'],
				],
			]) {
				contexts.length = 0;
				const marker = Symbol('query-context');
				const found = [];
				for await (const row of TableClass.search({ conditions, select: ['id'] }, { marker })) found.push(row.id);
				assert.deepStrictEqual(found.sort(), expected);
				assert.ok(
					contexts.length > 0 && contexts.every((context) => context?.marker === marker),
					JSON.stringify(conditions)
				);
			}
		} finally {
			Employee._readTxnForContext = readTxnForContext;
		}
	});

	it('deletes rows matching the same-record group vs separate existential conditions', async () => {
		const keyboardBrands = [
			{ id: 'both', group: 'g', departmentIds: ['d-split'] },
			{ id: 'keyboard', group: 'g', departmentIds: ['d-whole'] },
		];
		const remainingKeyboards = async () =>
			(await rows({ conditions: [name('Keyboard')()], select: ['id'] })).map(([id]) => id);
		try {
			await Brand.delete(new RequestTarget('?products[name=Keyboard&color=white]'));
			assert.deepStrictEqual(await remainingKeyboards(), ['both']);
			for (const brand of keyboardBrands) await Brand.put(brand);
			await Brand.delete(new RequestTarget('?products.name=Keyboard&products.color=white'));
			assert.deepStrictEqual(await remainingKeyboards(), []);
		} finally {
			for (const brand of keyboardBrands) await Brand.put(brand);
		}
	});

	it('treats a group on a to-one relationship as conditions on its one related record', async () => {
		const products = async (conditions) => {
			const found = [];
			for await (const row of Product.search({ conditions, select: ['id'] })) found.push(row.id);
			return found.sort();
		};
		const brand = (...conditions) => ({ attribute: 'brand', conditions });
		assert.deepStrictEqual(
			await products([brand({ attribute: 'id', value: 'both' }, { attribute: ['products', 'name'], value: 'Mouse' })]),
			['k1', 'm1']
		);
		assert.deepStrictEqual(
			await products([
				brand({
					attribute: 'products',
					conditions: [
						{ attribute: 'name', value: 'Cable' },
						{ attribute: 'price', comparator: 'ge', value: 30 },
					],
				}),
			]),
			['c2']
		);
	});

	it('drives an index scan through a to-one group or an OR inside a group, under allowFullScan: false', async () => {
		const brands = async (conditions) => {
			const found = [];
			for await (const row of Brand.search({ conditions, select: ['id'], allowFullScan: false })) found.push(row.id);
			return found.sort();
		};
		const viaBrand = {
			attribute: ['products', 'brand'],
			conditions: [
				{ attribute: 'id', value: 'both' },
				{ attribute: 'group', value: 'g' },
			],
		};
		assert.deepStrictEqual(await brands([viaBrand]), ['both']);
		const planned = (await Brand.search({ conditions: [viaBrand], explain: true, allowFullScan: false })).conditions;
		assert.deepStrictEqual(planned[0].attribute, ['products']);
		const either = {
			operator: 'or',
			conditions: [
				{ attribute: 'name', value: 'Cable' },
				{ attribute: 'name', value: 'Keyboard' },
			],
		};
		assert.deepStrictEqual(
			await brands([{ attribute: 'products', conditions: [either, { attribute: 'color', value: 'black' }] }]),
			['both', 'cable-split', 'cable-whole']
		);
		assert.deepStrictEqual(await brands([{ attribute: 'products', operator: 'or', conditions: either.conditions }]), [
			'both',
			'cable-split',
			'cable-whole',
			'keyboard',
		]);
		assert.deepStrictEqual(
			await brands([
				{
					attribute: 'products',
					operator: 'or',
					conditions: [either, { attribute: 'price', comparator: 'ge', value: 40 }],
				},
			]),
			['both', 'cable-split', 'cable-whole', 'keyboard']
		);
	});

	it("reads a group's condition without an attribute as the related primary key", async () => {
		const found = [];
		for await (const row of Product.search({
			conditions: [{ attribute: 'brand', conditions: [{ value: 'both' }] }],
			select: ['id'],
		}))
			found.push(row.id);
		assert.deepStrictEqual(found.sort(), ['k1', 'm1']);
	});

	it('selects the related record a key condition on a many-to-many relationship matched (#3814)', async () => {
		const departments = async (conditions) => {
			const found = [];
			for await (const row of Brand.search({ conditions, select: ['id', { name: 'departments', select: ['id'] }] }))
				found.push([row.id, row.departments.map((department) => department.id)]);
			return found;
		};
		assert.deepStrictEqual(await departments([{ attribute: ['departments', 'id'], value: 'd-split' }]), [
			['both', ['d-split']],
		]);
		assert.deepStrictEqual(
			await departments([
				{ attribute: ['departments', 'id'], value: 'd-split' },
				{ attribute: ['departments', 'name'], value: 'Split' },
			]),
			[['both', ['d-split']]]
		);
	});

	it('rejects a malformed same-record group with a 400', async () => {
		for (const condition of [
			{ attribute: 'group', conditions: [{ attribute: 'id', value: 'x' }] },
			{ attribute: 'products', conditions: [] },
			{ attribute: 'products', comparator: 'equals', value: 'x', conditions: [{ attribute: 'name', value: 'x' }] },
			{ attribute: 'products', negated: true, conditions: [{ attribute: 'name', value: 'x' }] },
			{ attribute: 'products', conditions: [{ attribute: 'name', comparator: 'fts', value: 'x' }] },
		])
			await assert.rejects(
				() => rows({ conditions: [condition] }),
				(error) => error.statusCode === 400,
				JSON.stringify(condition)
			);
	});

	it('authorizes the inner conditions against the related table', async () => {
		const asLimited = (conditions) =>
			(async () => {
				const found = [];
				for await (const row of Brand.search(
					{ conditions, select: ['id'], checkPermission: true },
					{ user: limitedUser }
				))
					found.push(row.id);
				return found;
			})();
		assert.deepStrictEqual(
			await asLimited([{ attribute: 'products', conditions: [{ attribute: 'name', value: 'Cable' }] }]).then((ids) =>
				ids.sort()
			),
			['cable-split', 'cable-whole']
		);
		for (const conditions of [
			[{ attribute: 'products', conditions: [{ attribute: 'price', comparator: 'ge', value: 30 }] }],
			[
				{
					attribute: 'products',
					conditions: [
						{
							operator: 'or',
							conditions: [
								{ attribute: 'name', value: 'none' },
								{ attribute: 'price', value: 1 },
							],
						},
					],
				},
			],
			[
				{ attribute: ['departments', 'employees'], conditions: [{ attribute: 'tag', value: 't' }] },
				{ attribute: 'products', conditions: [{ attribute: 'color', value: 'x' }] },
			],
		])
			await assert.rejects(
				() => asLimited(conditions),
				(error) => error.statusCode === 403,
				JSON.stringify(conditions)
			);
	});
});
