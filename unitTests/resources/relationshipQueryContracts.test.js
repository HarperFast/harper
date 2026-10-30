const assert = require('node:assert');
const { setImmediate: nextTick } = require('node:timers/promises');
const { setupTestDBPath } = require('../testUtils');
const { databases } = require('#src/resources/databases');
const { loadGQLSchema } = require('#src/resources/graphql');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

const isLMDB = process.env.HARPER_STORAGE_ENGINE === 'lmdb';

function clearValueMap(Table) {
	Table.primaryStore.flushSync?.();
	Table.primaryStore.cache?.clear?.();
	Table.primaryStore.valueMap?.clear?.();
}

// counts the outermost primary-store reads; an async read is delayed a turn so it behaves like a cold read
function spyPrimaryReads(Table) {
	const store = Table.primaryStore;
	const originals = new Map();
	let depth = 0;
	const stats = {
		async: 0,
		sync: 0,
		inFlight: 0,
		maxInFlight: 0,
		restore() {
			for (const [method, original] of originals) store[method] = original;
		},
	};
	const trackPromise = (promise) => {
		stats.async++;
		stats.inFlight++;
		if (stats.inFlight > stats.maxInFlight) stats.maxInFlight = stats.inFlight;
		const done = () => {
			stats.inFlight--;
		};
		promise.then(done, done);
		return promise;
	};
	const wrap = (method, isAsyncCall) => {
		const original = store[method];
		originals.set(method, original);
		store[method] = function (id, options) {
			const topLevel = depth === 0;
			depth++;
			try {
				const result = original.call(this, id, options);
				if (!topLevel) return result;
				if (!isAsyncCall(options)) {
					stats.sync++;
					return result;
				}
				if (typeof result?.then === 'function') return trackPromise(result);
				return trackPromise(nextTick().then(() => result));
			} finally {
				depth--;
			}
		};
	};
	wrap('getEntry', (options) => Boolean(options?.async));
	wrap('get', () => true);
	wrap('getSync', () => false);
	return stats;
}

async function collect(iterable) {
	const rows = [];
	for await (const row of iterable) rows.push(row);
	return rows;
}

describe('Relationship query contracts: async reads, select restrictions and sorting', function () {
	let Parent, ColdChild, ColdGrandchild, CompositeChild, Company, Department, Employee;

	before(async function () {
		setupTestDBPath();
		setMainIsWorker(true);
		await loadGQLSchema(`
			type ColdGrandchild @table(database: "relationshipQueryContracts") {
				id: ID @primaryKey
				code: String @indexed
				ownerId: ID @indexed
			}
			type ColdChild @table(database: "relationshipQueryContracts") {
				id: ID @primaryKey
				parentId: ID @indexed
				name: String @indexed
				label: String @indexed
				tier: String
				score: Int
				sortKey: String @indexed
				grandchildId: ID @indexed
				grandchild: ColdGrandchild @relationship(from: grandchildId)
				# named like a key the selection maps keep for themselves
				filters: [ColdGrandchild] @relationship(to: ownerId)
			}
			# no declared primary key: records are stored under a composite key that no record field holds
			type CompositeChild @table(database: "relationshipQueryContracts") {
				tenantId: String
				itemId: String
				parentId: ID @indexed
				label: String
			}
			type Parent @table(database: "relationshipQueryContracts") {
				id: ID @primaryKey
				group: String @indexed
				primaryChildId: ID @indexed
				primaryChild: ColdChild @relationship(from: primaryChildId)
				childIds: [ID] @indexed
				linkedChildren: [ColdChild] @relationship(from: childIds)
				children: [ColdChild] @relationship(to: parentId)
				compositeChildren: [CompositeChild] @relationship(to: parentId)
			}
			type Company @table(database: "relationshipQueryContracts") {
				id: ID @primaryKey
				group: String @indexed
				departments: [Department] @relationship(to: companyId)
			}
			type Department @table(database: "relationshipQueryContracts") {
				id: ID @primaryKey
				companyId: ID @indexed
				name: String @indexed
				employees: [Employee] @relationship(to: departmentId)
			}
			type Employee @table(database: "relationshipQueryContracts") {
				id: ID @primaryKey
				departmentId: ID @indexed
				role: String @indexed
				active: Boolean @indexed
				tag: String
			}
		`);
		const db = databases.relationshipQueryContracts;
		for (const Table of Object.values(db)) Table.loadAsInstance = false;
		({ Parent, ColdChild, ColdGrandchild, CompositeChild, Company, Department, Employee } = db);

		await ColdGrandchild.put({ id: 'gc-1', code: 'gc-alpha' });
		await ColdGrandchild.put({ id: 'gc-2', code: 'other-beta' });
		await ColdGrandchild.put({ id: 'gc-flag', code: 'flag-on', ownerId: 'c1' });
		const coldChildren = [
			['c1', 'parent-1', 'child-1a', 'match-alpha', 'silver', 10, 'z-ignore', 'gc-2'],
			['c2', 'parent-1', 'child-1b', 'match-beta', 'gold', 90, 'a-ignore', 'gc-1'],
			['c3', 'parent-1', 'child-1c', 'other-gamma', 'gold', 80, 'm-ignore', 'gc-2'],
			['c4', 'parent-2', 'child-2a', 'other-delta', 'bronze', 5, 'b-ignore', 'gc-2'],
			// different children of parent-3 satisfy different sibling conditions
			['c5', 'parent-3', 'child-3a', 'match-epsilon', 'silver', 1, 'y-ignore', 'gc-2'],
			['c6', 'parent-3', 'child-3b', 'other-zeta', 'gold', 1, 'x-ignore', 'gc-2'],
			// OR group: or-a's only child matches the second branch; of or-b's children, c8 matches the first and c9 neither
			['c7', 'or-a', 'child-or-a', 'B', 'gold', 1, 'w-ignore', 'gc-2'],
			['c8', 'or-b', 'child-or-b', 'A', 'silver', 1, 'v-ignore', 'gc-2'],
			['c9', 'or-b', 'child-or-b2', 'Z', 'silver', 1, 'u-ignore', 'gc-2'],
		];
		for (const [id, parentId, name, label, tier, score, sortKey, grandchildId] of coldChildren)
			await ColdChild.put({ id, parentId, name, label, tier, score, sortKey, grandchildId });
		await Parent.put({ id: 'parent-1', group: 'g1', primaryChildId: 'c2', childIds: ['c1', 'c2', 'c3'] });
		await Parent.put({ id: 'parent-2', group: 'g1', primaryChildId: 'c1', childIds: ['c4'] });
		await Parent.put({ id: 'parent-3', group: 'g3', childIds: ['c5', 'c6'] });
		await Parent.put({ id: 'or-a', group: 'or-grp', childIds: [] });
		await Parent.put({ id: 'or-b', group: 'or-grp', childIds: [] });

		await CompositeChild.put(['t1', 'i1'], { tenantId: 't1', itemId: 'i1', parentId: 'parent-1', label: 'keep-me' });
		await CompositeChild.put(['t1', 'i2'], { tenantId: 't1', itemId: 'i2', parentId: 'parent-1', label: 'drop-me' });

		await Company.put({ id: 'co-split', group: 'g1' });
		await Company.put({ id: 'co-match', group: 'g1' });
		await Department.put({ id: 'dept-split', companyId: 'co-split', name: 'Split Dept' });
		// two to-many hops wide enough that resolving them together would exceed one read window
		await Company.put({ id: 'co-wide', group: 'wide-co' });
		for (let d = 0; d < 3; d++) {
			await Department.put({ id: `dw-${d}`, companyId: 'co-wide', name: `Wide ${d}` });
			for (let e = 0; e < 12; e++)
				await Employee.put({
					id: `ew-${d}-${e}`,
					departmentId: `dw-${d}`,
					role: 'wide',
					active: true,
					tag: `w-${d}-${e}`,
				});
		}
		await Department.put({ id: 'dept-match', companyId: 'co-match', name: 'Match Dept' });
		// co-split has an engineer and an active employee, but no active engineer
		await Employee.put({ id: 'emp-split-1', departmentId: 'dept-split', role: 'eng', active: false, tag: 'match-tag' });
		await Employee.put({
			id: 'emp-split-2',
			departmentId: 'dept-split',
			role: 'sales',
			active: true,
			tag: 'other-tag',
		});
		await Employee.put({ id: 'emp-match-1', departmentId: 'dept-match', role: 'eng', active: true, tag: 'match-tag' });
		await Employee.put({ id: 'emp-match-2', departmentId: 'dept-match', role: 'eng', active: false, tag: 'other-tag' });

		const sortChildren = [
			['cs-1', 'p-sort-1', 'charlie'],
			['cs-2', 'p-sort-2', 'alpha'],
			['cs-3', 'p-sort-3', 'bravo'],
			['cs-4a', 'p-sort-4', 'alpha'],
			['cs-4b', 'p-sort-4', 'delta'],
		];
		for (const [id, parentId, sortKey] of sortChildren)
			await ColdChild.put({ id, parentId, name: id, label: 'sort-label', tier: 'gold', sortKey, grandchildId: 'gc-2' });
		for (const [id, childIds] of [
			['p-sort-1', ['cs-1']],
			['p-sort-2', ['cs-2']],
			['p-sort-3', ['cs-3']],
			['p-sort-4', ['cs-4a', 'cs-4b']],
		])
			await Parent.put({ id, group: 'sort-grp', primaryChildId: childIds[0], childIds });
		// more children than are resolved at once (RELATED_READS_IN_FLIGHT), each with its own grandchild
		for (let i = 0; i < 40; i++) {
			await ColdGrandchild.put({ id: `gc-wide-${i}`, code: `wide-${String(i).padStart(2, '0')}` });
			await ColdChild.put({ id: `cw-${i}`, parentId: 'p-wide', name: `cw-${i}`, grandchildId: `gc-wide-${i}` });
		}
		await Parent.put({ id: 'p-wide', group: 'wide-grp', childIds: [] });
		// a grandchild condition led by this four-row group switches to index-derived id sets two hops down
		for (let i = 0; i < 4; i++) {
			await Parent.put({ id: `idset-${i}`, group: 'idset-grp', childIds: [] });
			for (const suffix of ['a', 'b'])
				await ColdChild.put({
					id: `ci-${i}-${suffix}`,
					parentId: `idset-${i}`,
					name: `ci-${i}-${suffix}`,
					grandchildId: (i === 1 && suffix === 'b') || (i === 3 && suffix === 'a') ? 'gc-1' : 'gc-2',
				});
		}
		// enough rows that a two-row group condition leads without reordering
		for (let i = 0; i < 22; i++) await Parent.put({ id: `p-filler-${i}`, group: 'filler-grp', childIds: [] });
	});

	describe('async reads on cold tables', function () {
		it('a non-leading to-many condition reads asynchronously, filters the selected children and freezes them', async function () {
			clearValueMap(ColdChild);
			const reads = spyPrimaryReads(ColdChild);
			try {
				const rows = await collect(
					Parent.search({
						conditions: [
							{ attribute: 'group', value: 'g1' },
							{ attribute: ['children', 'label'], comparator: 'starts_with', value: 'match' },
						],
						select: ['id', 'children'],
					})
				);
				assert.strictEqual(reads.sync, 0);
				assert.ok(reads.async > 0);
				assert.deepStrictEqual(
					rows.map((row) => row.id),
					['parent-1']
				);
				assert.deepStrictEqual(
					rows[0].children.map((child) => child.id),
					['c1', 'c2']
				);
				for (const child of rows[0].children) assert.strictEqual(Object.isFrozen(child), true);
			} finally {
				reads.restore();
			}
		});

		it('leading joinTo and joinFrom conditions read asynchronously and filter the selected children', async function () {
			for (const name of ['children', 'linkedChildren']) {
				clearValueMap(ColdChild);
				const reads = spyPrimaryReads(ColdChild);
				try {
					const rows = await collect(
						Parent.search({ conditions: [{ attribute: [name, 'name'], value: 'child-1b' }], select: ['id', name] })
					);
					assert.strictEqual(reads.sync, 0, name);
					assert.ok(reads.async > 0, name);
					assert.strictEqual(rows.length, 1, name);
					assert.deepStrictEqual(
						rows[0][name].map((child) => child.name),
						['child-1b']
					);
				} finally {
					reads.restore();
				}
			}
		});

		it('sorting by a to-one relationship attribute reads asynchronously', async function () {
			for (const descending of [false, true]) {
				clearValueMap(ColdChild);
				const reads = spyPrimaryReads(ColdChild);
				try {
					const rows = await collect(
						Parent.search({
							conditions: [{ attribute: 'group', value: 'g1' }],
							sort: { attribute: ['primaryChild', 'name'], descending },
							select: ['id'],
						})
					);
					assert.strictEqual(reads.sync, 0);
					assert.ok(reads.async > 0);
					assert.deepStrictEqual(
						rows.map((row) => row.id),
						descending ? ['parent-1', 'parent-2'] : ['parent-2', 'parent-1']
					);
				} finally {
					reads.restore();
				}
			}
		});
	});

	describe('select restrictions from non-leading conditions', function () {
		it('every sibling condition on a to-many relationship restricts its select()', async function () {
			for (const name of ['children', 'linkedChildren']) {
				clearValueMap(ColdChild);
				const rows = await collect(
					Parent.search({
						conditions: [
							{ attribute: 'group', value: 'g1' },
							{ attribute: [name, 'label'], comparator: 'starts_with', value: 'match' },
							{ attribute: [name, 'tier'], value: 'gold' },
						],
						select: ['id', { name, select: ['id', 'label', 'tier'] }],
					})
				);
				assert.strictEqual(rows.length, 1, name);
				assert.deepStrictEqual(rows[0][name], [{ id: 'c2', label: 'match-beta', tier: 'gold' }], name);
			}
		});

		it('sibling conditions met by different children match the parent but select only children meeting both', async function () {
			const rows = await collect(
				Parent.search({
					conditions: [
						{ attribute: 'group', value: 'g3' },
						{ attribute: ['children', 'label'], comparator: 'starts_with', value: 'match' },
						{ attribute: ['children', 'tier'], value: 'gold' },
					],
					select: ['id', { name: 'children', select: ['id'] }],
				})
			);
			assert.deepStrictEqual(rows, [{ id: 'parent-3', children: [] }]);
		});

		it('a condition inside an OR group decides rows and never narrows the selected children', async function () {
			const rows = await collect(
				Parent.search({
					conditions: [
						{ attribute: 'group', value: 'or-grp' },
						{
							operator: 'or',
							conditions: [
								{ attribute: ['children', 'label'], value: 'A' },
								{ attribute: ['children', 'tier'], value: 'gold' },
							],
						},
					],
					enforceExecutionOrder: true,
					select: ['id', { name: 'children', select: ['id'] }],
				})
			);
			assert.deepStrictEqual(
				rows.map((row) => row.id),
				['or-a', 'or-b']
			);
			assert.deepStrictEqual(rows[0].children, [{ id: 'c7' }]);
			assert.deepStrictEqual(rows[1].children, [{ id: 'c8' }, { id: 'c9' }]);
		});

		it('a nested selection with a limit is not narrowed by a condition inside an OR group', async function () {
			const rows = await collect(
				Parent.search({
					conditions: [
						{ attribute: 'group', value: 'or-grp' },
						{
							operator: 'or',
							conditions: [
								{ attribute: ['children', 'label'], value: 'A' },
								{ attribute: ['children', 'tier'], value: 'gold' },
							],
						},
					],
					enforceExecutionOrder: true,
					select: ['id', { name: 'children', limit: 10, select: ['id'] }],
				})
			);
			assert.deepStrictEqual(rows[1], { id: 'or-b', children: [{ id: 'c8' }, { id: 'c9' }] });
		});

		it('a related table without a primary-key field selects matched records by their entry key', async function () {
			const unfiltered = await collect(
				Parent.search({
					conditions: [{ attribute: 'id', value: 'parent-1' }],
					select: ['id', { name: 'compositeChildren', select: ['tenantId', 'itemId', 'label'] }],
				})
			);
			assert.deepStrictEqual(unfiltered[0].compositeChildren, [
				{ tenantId: 't1', itemId: 'i1', label: 'keep-me' },
				{ tenantId: 't1', itemId: 'i2', label: 'drop-me' },
			]);
			const query = {
				conditions: [
					{ attribute: 'id', value: 'parent-1' },
					{ attribute: ['compositeChildren', 'label'], comparator: 'starts_with', value: 'keep' },
				],
				select: ['id', { name: 'compositeChildren', select: ['tenantId', 'itemId', 'label'] }],
			};
			const expected = [{ tenantId: 't1', itemId: 'i1', label: 'keep-me' }];
			clearValueMap(CompositeChild);
			assert.deepStrictEqual((await collect(Parent.search(query)))[0].compositeChildren, expected, 'cold');
			assert.deepStrictEqual((await collect(Parent.search(query)))[0].compositeChildren, expected, 'warm');
			assert.deepStrictEqual(Array.from(Parent.search(query))[0].compositeChildren, expected, 'sync');
		});
	});

	describe('multi-hop relationship conditions', function () {
		it('a second condition on a leading two-hop path filters the same innermost records', async function () {
			clearValueMap(Department);
			clearValueMap(Employee);
			const rows = await collect(
				Company.search({
					conditions: [
						{ attribute: ['departments', 'employees', 'role'], value: 'eng' },
						{ attribute: ['departments', 'employees', 'active'], value: true },
					],
					select: [
						'id',
						{ name: 'departments', select: ['id', { name: 'employees', select: ['id', 'role', 'active'] }] },
					],
					enforceExecutionOrder: true,
				})
			);
			assert.deepStrictEqual(rows, [
				{
					id: 'co-match',
					departments: [{ id: 'dept-match', employees: [{ id: 'emp-match-1', role: 'eng', active: true }] }],
				},
			]);
		});

		it('a non-leading two-hop condition restricts the nested select()', async function () {
			clearValueMap(Department);
			clearValueMap(Employee);
			const rows = await collect(
				Company.search({
					conditions: [
						{ attribute: 'id', value: 'co-match' },
						{ attribute: ['departments', 'employees', 'tag'], comparator: 'starts_with', value: 'match' },
					],
					select: ['id', { name: 'departments', select: ['id', { name: 'employees', select: ['id', 'tag'] }] }],
				})
			);
			assert.deepStrictEqual(rows, [
				{ id: 'co-match', departments: [{ id: 'dept-match', employees: [{ id: 'emp-match-1', tag: 'match-tag' }] }] },
			]);
		});

		it('a second hop through a relationship named like selection bookkeeping still filters and projects', async function () {
			const rows = await collect(
				Parent.search({
					conditions: [
						{ attribute: 'group', value: 'g1' },
						{ attribute: ['children', 'filters', 'code'], value: 'flag-on' },
					],
					select: ['id', { name: 'children', select: ['id', { name: 'filters', select: ['code'] }] }],
				})
			);
			assert.deepStrictEqual(rows, [{ id: 'parent-1', children: [{ id: 'c1', filters: [{ code: 'flag-on' }] }] }]);
		});

		it('an id set of intermediate keys from two hops down is not tested as parent keys', async function () {
			// planner-ordered, so the group condition leads with an estimate that enables the adaptive index switch
			const query = {
				conditions: [
					{ attribute: 'group', value: 'idset-grp' },
					{ attribute: ['children', 'grandchild', 'code'], value: 'gc-alpha' },
				],
				select: ['id'],
			};
			const expected = ['idset-1', 'idset-3'];
			assert.deepStrictEqual(
				(await collect(Parent.search(query))).map((row) => row.id),
				expected
			);
			// LMDB cannot iterate an index-led filtered search synchronously
			if (!isLMDB)
				assert.deepStrictEqual(
					Array.from(Parent.search(query)).map((row) => row.id),
					expected
				);
		});
	});

	describe('nested relationship selections', function () {
		it('a leading join with nested conditions reads candidates asynchronously and freezes them', async function () {
			clearValueMap(ColdChild);
			const reads = spyPrimaryReads(ColdChild);
			try {
				const rows = await collect(
					Parent.search({
						conditions: [{ attribute: ['children', 'label'], value: 'match-beta' }],
						select: ['id', { name: 'children', conditions: [{ attribute: 'tier', value: 'gold' }] }],
					})
				);
				assert.deepStrictEqual(
					rows.map((row) => [row.id, row.children.map((child) => child.id)]),
					[['parent-1', ['c2']]]
				);
				assert.strictEqual(reads.sync, 0);
				assert.ok(reads.async > 0);
				assert.strictEqual(Object.isFrozen(rows[0].children[0]), true);
			} finally {
				reads.restore();
			}
		});

		it('a nested condition through a further relationship reads it asynchronously', async function () {
			clearValueMap(ColdChild);
			clearValueMap(ColdGrandchild);
			const reads = spyPrimaryReads(ColdGrandchild);
			try {
				const rows = await collect(
					Parent.search({
						conditions: [{ attribute: 'id', value: 'parent-1' }],
						select: [
							'id',
							{
								name: 'children',
								conditions: [{ attribute: ['grandchild', 'code'], comparator: 'starts_with', value: 'gc-' }],
								select: ['id'],
							},
						],
					})
				);
				assert.deepStrictEqual(rows, [{ id: 'parent-1', children: [{ id: 'c2' }] }]);
				assert.strictEqual(reads.sync, 0);
				assert.ok(reads.async > 0);
			} finally {
				reads.restore();
			}
		});

		it('under synchronous iteration a nested condition through a further relationship stays synchronous', function () {
			const rows = Array.from(
				Parent.search({
					conditions: [{ attribute: 'id', value: 'parent-1' }],
					select: [
						'id',
						{
							name: 'children',
							conditions: [{ attribute: ['grandchild', 'code'], comparator: 'starts_with', value: 'gc-' }],
							select: ['id'],
						},
					],
				})
			);
			assert.deepStrictEqual(rows, [{ id: 'parent-1', children: [{ id: 'c2' }] }]);
		});
	});

	describe('sorting across a to-many relationship', function () {
		it('sorts by the related values in relationship order, compared element by element', async function () {
			const sortedIds = async (attribute, descending) =>
				(
					await collect(
						Parent.search({
							conditions: [{ attribute: 'group', value: 'sort-grp' }],
							sort: { attribute, descending },
							select: ['id'],
						})
					)
				).map((row) => row.id);
			clearValueMap(ColdChild);
			const reads = spyPrimaryReads(ColdChild);
			try {
				assert.deepStrictEqual(await sortedIds(['children', 'sortKey'], false), [
					'p-sort-2',
					'p-sort-4',
					'p-sort-3',
					'p-sort-1',
				]);
				assert.strictEqual(reads.sync, 0);
				assert.ok(reads.async > 0);
			} finally {
				reads.restore();
			}
			assert.deepStrictEqual(await sortedIds(['children', 'sortKey'], true), [
				'p-sort-1',
				'p-sort-3',
				'p-sort-4',
				'p-sort-2',
			]);
			assert.deepStrictEqual(await sortedIds(['linkedChildren', 'sortKey'], false), [
				'p-sort-2',
				'p-sort-4',
				'p-sort-3',
				'p-sort-1',
			]);
		});

		it('a two-hop sort through a wide to-many relationship bounds its in-flight reads', async function () {
			clearValueMap(ColdChild);
			clearValueMap(ColdGrandchild);
			const reads = spyPrimaryReads(ColdGrandchild);
			try {
				const rows = await collect(
					Parent.search({
						conditions: [{ attribute: 'group', value: 'wide-grp' }],
						sort: { attribute: ['children', 'grandchild', 'code'] },
						select: ['id'],
					})
				);
				assert.deepStrictEqual(rows, [{ id: 'p-wide' }]);
				assert.strictEqual(reads.sync, 0);
				assert.strictEqual(reads.async, 40);
				assert.ok(reads.maxInFlight <= 16, `at most 16 grandchild reads in flight, saw ${reads.maxInFlight}`);
			} finally {
				reads.restore();
			}
		});

		it('a sort through two to-many hops shares one read window', async function () {
			clearValueMap(Department);
			clearValueMap(Employee);
			const reads = spyPrimaryReads(Employee);
			try {
				const rows = await collect(
					Company.search({
						conditions: [{ attribute: 'group', value: 'wide-co' }],
						sort: { attribute: ['departments', 'employees', 'tag'] },
						select: ['id'],
					})
				);
				assert.deepStrictEqual(rows, [{ id: 'co-wide' }]);
				assert.strictEqual(reads.sync, 0);
				assert.strictEqual(reads.async, 36);
				assert.ok(reads.maxInFlight <= 16, `at most 16 employee reads in flight, saw ${reads.maxInFlight}`);
			} finally {
				reads.restore();
			}
		});
	});
});
