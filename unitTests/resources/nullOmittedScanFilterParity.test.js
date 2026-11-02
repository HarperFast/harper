// harper#3731, harper#3400

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { estimateCondition } = require('#src/resources/search');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { evaluateSQL } = require('#src/sqlTranslator/index');
const { runWithOperationAuthorizationBypass } = require('#src/server/serverHelpers/operationAuthorizationState');

const ROWS = [
	{ id: 'v0', b: 0 },
	{ id: 'v1', b: 1 },
	{ id: 'v5', b: 5 },
	{ id: 'vneg', b: -2 },
	{ id: 'vnull', b: null },
	{ id: 'vomitted' },
];
const PRESENT = ['v0', 'v1', 'v5', 'vneg'];
const ABSENT = ['vnull', 'vomitted'];

const CASES = [
	['ne', 0, ['v1', 'v5', 'vneg', ...ABSENT]],
	['not_equal', 5, ['v0', 'v1', 'vneg', ...ABSENT]],
	['ne', null, PRESENT],
	['lt', 3, ['v0', 'v1', 'vneg']],
	['le', 1, ['v0', 'v1', 'vneg']],
	['gt', 0, ['v1', 'v5']],
	['ge', 1, ['v1', 'v5']],
	['ge', null, PRESENT],
	['greater_than_equal', null, PRESENT],
	['gt', null, PRESENT],
	['lt', null, []],
	['le', null, []],
	['between', [0, 3], ['v0', 'v1']],
	['between', [null, 1], ['v0', 'v1', 'vneg']],
	['gele', [null, 1], ['v0', 'v1', 'vneg']],
	['gelt', [null, 1], ['v0', 'vneg']],
	['gtle', [null, 1], ['v0', 'v1', 'vneg']],
	['gtlt', [null, 1], ['v0', 'vneg']],
	['between', [0, null], []],
	['between', [null, null], []],
];

const sorted = (ids) => [...ids].sort();
const dayOf = (offset) => new Date(Date.UTC(2026, 0, 10 + offset));

describe('null and omitted values match the same way on every search path', function () {
	this.timeout(60000);

	let Table;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Table = table({
			table: 'NullOmittedScanFilterParity',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'c', type: 'String', indexed: true },
				{ name: 'b', type: 'Int', indexed: true },
				{ name: 'u', type: 'Int' },
				{ name: 'g', type: 'Int', indexed: true },
				{ name: 'd', type: 'Date', indexed: true },
			],
		});
		let lastPut;
		ROWS.forEach((row, i) => {
			const record = { id: row.id, c: 'hot', g: i % 2 };
			if ('b' in row) {
				record.b = record.u = row.b;
				record.d = row.b === null ? null : dayOf(row.b);
			}
			lastPut = Table.put(record);
		});
		await lastPut;
		if (Table.indexingOperation) await Table.indexingOperation;
	});

	async function ids(request) {
		const found = [];
		for await (const record of Table.search(request)) found.push(record.id);
		return found;
	}

	async function leadsWith(request, attribute) {
		const plan = await Table.search({ ...request, explain: true });
		assert.strictEqual(plan.conditions[0].attribute, attribute, `${attribute} leads ${JSON.stringify(request)}`);
	}

	const hot = () => ({ attribute: 'c', value: 'hot' });
	const condition = (attribute, comparator, value) => ({ attribute, comparator, value });

	for (const [comparator, value, expected] of CASES) {
		describe(`${comparator} ${JSON.stringify(value)}`, () => {
			const paths = {
				'indexed lead': () => ({ conditions: [condition('b', comparator, value)] }),
				'indexed lead, reversed': () => ({ conditions: [condition('b', comparator, value)], reverse: true }),
				'indexed lead pinned ahead of another index': () => ({
					conditions: [condition('b', comparator, value), hot()],
					enforceExecutionOrder: true,
				}),
				'indexed filter': () => ({
					conditions: [hot(), condition('b', comparator, value)],
					enforceExecutionOrder: true,
				}),
				'indexed OR branch': () => ({
					operator: 'or',
					conditions: [condition('b', comparator, value), { attribute: 'c', value: 'never' }],
				}),
				'unindexed scan': () => ({ conditions: [condition('u', comparator, value)] }),
				'unindexed filter': () => ({
					conditions: [hot(), condition('u', comparator, value)],
					enforceExecutionOrder: true,
				}),
			};
			for (const [path, request] of Object.entries(paths)) {
				it(path, async () => {
					if (path.startsWith('indexed lead pinned')) await leadsWith(request(), 'b');
					if (path === 'indexed filter') await leadsWith(request(), 'c');
					assert.deepStrictEqual(sorted(await ids(request())), sorted(expected));
				});
			}
		});
	}

	describe('sorting on the attribute of a lead that reads the primary store', () => {
		// null and omitted values sort together, so only their place among the values is pinned
		const sortKeys = (found) => found.map((id) => ROWS.find((row) => row.id === id).b ?? 'none');

		for (const [label, conditions, attribute, expected] of [
			['indexed ne', [condition('b', 'ne', 0)], 'b', ['none', 'none', -2, 1, 5]],
			['negated range', [{ ...condition('b', 'lt', 1), negated: true }], 'b', ['none', 'none', 1, 5]],
			['unindexed range', [condition('u', 'lt', 3)], 'u', [-2, 0, 1]],
		]) {
			it(`${label} returns its rows in sort order, both directions`, async () => {
				const ascending = await ids({ conditions, sort: { attribute } });
				assert.deepStrictEqual(sortKeys(ascending), expected);
				const descending = await ids({ conditions, sort: { attribute, descending: true } });
				assert.deepStrictEqual(sortKeys(descending), [...expected].reverse());
				assert.deepStrictEqual(sorted(descending), sorted(ascending));
			});
		}

		it('pages a sorted ne lead after sorting', async () => {
			const request = { conditions: [condition('b', 'ne', 0)], sort: { attribute: 'b' }, offset: 1, limit: 3 };
			assert.deepStrictEqual(sortKeys(await ids(request)), ['none', -2, 1]);
		});

		it('applies the next sort key under a primary-store lead', async () => {
			const conditions = [condition('g', 'ne', 7)];
			const sort = { attribute: 'g', next: { attribute: 'b', descending: true } };
			assert.deepStrictEqual(sortKeys(await ids({ conditions, sort })), [5, 0, 'none', 1, -2, 'none']);
		});

		it('lets an index drive instead of a sort-aligned lead that cannot stream the sort', async () => {
			const request = { conditions: [condition('u', 'lt', 3), hot()], sort: { attribute: 'u' } };
			const plan = await Table.search({ ...request, explain: true });
			assert.ok(plan.conditions[1].estimated_count < plan.conditions[0].estimated_count, 'u is the narrower estimate');
			await leadsWith(request, 'c');
			assert.deepStrictEqual(sortKeys(await ids(request)), [-2, 0, 1]);
		});

		it('still streams the index order for a lead that scans its index', async () => {
			const request = { conditions: [condition('b', 'ge', 0)], sort: { attribute: 'b' } };
			assert.strictEqual((await Table.search({ ...request, explain: true })).postOrdering, undefined);
			assert.deepStrictEqual(await ids(request), ['v0', 'v1', 'v5']);
		});
	});

	it('excludes an equal Date from a non-null ne, led or filtered', async () => {
		const ne = condition('d', 'ne', dayOf(1));
		for (const request of [
			{ conditions: [ne] },
			{ conditions: [hot(), ne], enforceExecutionOrder: true },
			{ operator: 'or', conditions: [ne, { attribute: 'c', value: 'never' }] },
		])
			assert.deepStrictEqual(
				sorted(await ids(request)),
				sorted(['v0', 'v5', 'vneg', ...ABSENT]),
				JSON.stringify(request)
			);
	});

	it('estimates the open range a null lower bound executes', function () {
		const index = Table.indices.b;
		if (typeof index.estimateCount !== 'function') this.skip();
		const original = index.estimateCount;
		const ranges = [];
		index.estimateCount = function (range) {
			ranges.push({ start: range.start, exclusiveStart: range.exclusiveStart });
			return original.call(this, range);
		};
		try {
			for (const [comparator, value] of [
				['ge', null],
				['gt', null],
				['between', [null, 1]],
				['gelt', [null, 1]],
			])
				estimateCondition(Table)({ attribute: 'b', comparator, value });
		} finally {
			index.estimateCount = original;
		}
		assert.deepStrictEqual(ranges, Array(4).fill({ start: null, exclusiveStart: true }));
	});

	describe('allowFullScan: false', () => {
		it('still refuses a lone non-null ne', async () => {
			await assert.rejects(
				ids({ conditions: [condition('b', 'ne', 0)], allowFullScan: false }),
				(error) => error.statusCode === 403
			);
		});

		it('still allows a non-null ne beside a condition that drives an index', async () => {
			const found = await ids({ conditions: [hot(), condition('b', 'ne', 0)], allowFullScan: false });
			assert.deepStrictEqual(sorted(found), sorted(['v1', 'v5', 'vneg', ...ABSENT]));
		});
	});

	describe('SQL', () => {
		let originalEngine;
		before(() => {
			originalEngine = process.env.HARPER_SQL_ENGINE;
		});
		after(() => {
			if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
			else process.env.HARPER_SQL_ENGINE = originalEngine;
		});

		function sql(engine, where) {
			process.env.HARPER_SQL_ENGINE = engine;
			return runWithOperationAuthorizationBypass(
				true,
				() =>
					new Promise((resolve, reject) =>
						evaluateSQL(
							{ sql: `SELECT id FROM test.NullOmittedScanFilterParity WHERE ${where}`, hdb_user: { username: 'test' } },
							(error, rows) => (error ? reject(error) : resolve(rows.map((row) => row.id).sort()))
						)
					)
			);
		}

		for (const [operator, value, expected] of [
			['<>', 0, ['v1', 'v5', 'vneg']],
			['<', 3, ['v0', 'v1', 'vneg']],
			['<=', 1, ['v0', 'v1', 'vneg']],
			['>', 0, ['v1', 'v5']],
			['>=', 1, ['v1', 'v5']],
			['BETWEEN', '0 AND 3', ['v0', 'v1']],
			['>=', 'NULL', []],
			['<', 'NULL', []],
			['BETWEEN', 'NULL AND 3', []],
		]) {
			for (const engine of ['legacy', 'auto', 'new']) {
				it(`${engine}: ${operator} ${value} returns the same rows led, filtered and unindexed`, async () => {
					const wheres = [
						`b ${operator} ${value}`,
						`c = 'hot' AND b ${operator} ${value}`,
						`c = 'hot' AND u ${operator} ${value}`,
					];
					// sql.engine new refuses a query with no condition that can drive an index
					if (engine !== 'new') wheres.push(`u ${operator} ${value}`);
					if (engine === 'new' && String(value).includes('NULL')) wheres.shift();
					for (const where of wheres) assert.deepStrictEqual(await sql(engine, where), sorted(expected), where);
				});
			}
		}
	});
});

describe('a sort on a relationship path follows the related scan', function () {
	let Parent;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		const Child = table({
			table: 'NullOmittedScanFilterParityChild',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'b', type: 'Int', indexed: true },
			],
		});
		Parent = table({
			table: 'NullOmittedScanFilterParityParent',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'childId', type: 'ID', indexed: true },
				{ name: 'child', relationship: { from: 'childId' }, definition: { tableClass: Child } },
			],
		});
		// child primary-key order (a, b, c, …) differs from b order
		for (const [id, b] of [
			['a', 3],
			['b', 1],
			['c', 2],
			['d', null],
			['e', undefined],
		])
			await Child.put(b === undefined ? { id } : { id, b });
		for (const childId of ['a', 'b', 'c', 'd', 'e']) await Parent.put({ id: `p-${childId}`, childId });
		for (const table of [Child, Parent]) if (table.indexingOperation) await table.indexingOperation;
	});

	async function childIds(request) {
		const found = [];
		for await (const record of Parent.search({ ...request, select: ['childId'] })) found.push(record.childId);
		return found;
	}

	it('sorts a related lead that reads the related primary store', async () => {
		const sort = { attribute: ['child', 'b'] };
		for (const [condition, valueOrder] of [
			[{ attribute: ['child', 'b'], comparator: 'ne', value: 2 }, ['b', 'a']],
			[{ attribute: ['child', 'b'], comparator: 'ne', value: 9 }, ['b', 'c', 'a']],
			[{ attribute: ['child', 'b'], comparator: 'ge', value: 2, negated: true }, ['b']],
		]) {
			const ascending = await childIds({ conditions: [condition], sort });
			assert.deepStrictEqual(ascending.slice(0, 2).sort(), ['d', 'e'], JSON.stringify(condition));
			assert.deepStrictEqual(ascending.slice(2), valueOrder, JSON.stringify(condition));
		}
	});

	it('streams a related lead that scans the related index', async () => {
		const request = {
			conditions: [{ attribute: ['child', 'b'], comparator: 'ge', value: 1 }],
			sort: { attribute: ['child', 'b'] },
		};
		assert.strictEqual((await Parent.search({ ...request, explain: true })).postOrdering, undefined);
		assert.deepStrictEqual(await childIds(request), ['b', 'c', 'a']);
	});
});

describe('a multi-valued attribute answers a non-null ne the same led or filtered', function () {
	let Table;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Table = table({
			table: 'NullOmittedScanFilterParityArrays',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', type: 'ID', isPrimaryKey: true },
				{ name: 'c', type: 'String', indexed: true },
				{ name: 'tags', type: 'array', elements: { type: 'String' }, indexed: true },
				{ name: 'days', type: 'array', elements: { type: 'Date' }, indexed: true },
			],
		});
		let lastPut;
		for (const [id, tags] of [
			['x', ['x']],
			['xx', ['x', 'x']],
			['xy', ['x', 'y']],
			['y', ['y']],
			['empty', []],
			['null', null],
		])
			lastPut = Table.put({ id, c: 'hot', tags, days: tags?.map((tag) => dayOf(tag.charCodeAt(0))) });
		await Table.put({ id: 'omitted', c: 'hot' });
		await lastPut;
		if (Table.indexingOperation) await Table.indexingOperation;
	});

	for (const [value, expected] of [
		['x', ['null', 'omitted', 'xy', 'y']],
		[null, ['x', 'xx', 'xy', 'y']],
	])
		it(`ne ${value} matches the same records once each, led or filtered`, async () => {
			const day = value && dayOf(value.charCodeAt(0));
			for (const ne of [
				{ attribute: 'tags', comparator: 'ne', value },
				{ attribute: 'days', comparator: 'ne', value: day },
				...(day ? [{ attribute: 'days', comparator: 'ne', value: day.getTime() }] : []),
			])
				for (const request of [
					{ conditions: [ne] },
					{ conditions: [{ attribute: 'c', value: 'hot' }, ne], enforceExecutionOrder: true },
				]) {
					const found = [];
					for await (const record of Table.search(request)) found.push(record.id);
					assert.deepStrictEqual(found.sort(), expected, JSON.stringify(request.conditions));
				}
		});

	it('matches Date array elements by epoch number for equals and ranges, led or filtered', async () => {
		const x = dayOf('x'.charCodeAt(0));
		for (const [condition, expected] of [
			[{ attribute: 'days', value: x }, ['x', 'xx', 'xy']],
			[{ attribute: 'days', comparator: 'gt', value: x }, ['xy', 'y']],
			[{ attribute: 'days', comparator: 'le', value: x }, ['x', 'xx', 'xy']],
		])
			for (const request of [
				{ conditions: [condition] },
				{ conditions: [{ attribute: 'c', value: 'hot' }, condition], enforceExecutionOrder: true },
			]) {
				const found = [];
				for await (const record of Table.search(request)) found.push(record.id);
				assert.deepStrictEqual(found.sort(), expected, JSON.stringify(request.conditions));
			}
	});
});

const describeUnlessLmdb = process.env.HARPER_STORAGE_ENGINE === 'lmdb' ? describe.skip : describe;

describeUnlessLmdb('a candidate-key allow-set for a null lower bound excludes null values', function () {
	let Table;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		Table = table({
			table: 'NullOmittedScanFilterParityVector',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'score', indexed: true, type: 'Int' },
				{ name: 'vector', indexed: { type: 'HNSW', distance: 'euclidean', quantization: 'none' }, type: 'Array' },
			],
		});
		for (let i = 0; i < 300; i++) {
			const record = { vector: [i, 0] };
			if (i > 0) record.score = i === 1 ? null : (i % 20) - 10;
			await Table.put(i, record);
		}
	});

	after(() => Table.dropTable());

	it('builds the set from above the null block', async () => {
		const customIndex = Table.indices.vector.customIndex;
		const original = customIndex.search;
		let probed;
		customIndex.search = function (searchCondition, context, options) {
			if (options.candidateKeys) probed = options.candidateKeys.collect(100_000);
			return original.call(this, searchCondition, context, options);
		};
		const sort = { attribute: 'vector', target: [0, 0], distance: 'euclidean' };
		const found = [];
		try {
			for await (const record of Table.search({
				conditions: [
					{ attribute: 'vector', comparator: 'sort', ...sort },
					{ attribute: 'score', comparator: 'between', value: [null, -6] },
				],
				sort,
				enforceExecutionOrder: true,
				select: ['id', 'score'],
				limit: 300,
			}))
				found.push(record);
		} finally {
			customIndex.search = original;
		}
		assert.ok(probed, 'the range sibling seeds a candidate-key allow-set');
		const expected = [];
		for (let i = 2; i < 300; i++) if ((i % 20) - 10 <= -6) expected.push(i);
		assert.strictEqual(probed.keys.size, expected.length);
		for (const id of expected) assert.ok(probed.keys.has(id), `the set holds ${id}`);
		assert.ok(!probed.keys.has(0) && !probed.keys.has(1), 'the set holds neither the omitted nor the null score');
		assert.ok(found.length > 0);
		for (const record of found) assert.ok(record.score != null && record.score <= -6, JSON.stringify(record));
	});
});
