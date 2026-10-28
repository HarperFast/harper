const assert = require('node:assert');
const alasql = require('alasql');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { estimateCondition, estimatedEntryCount, conditionDrivesIndex } = require('#src/resources/search');
const { RequestTarget } = require('#src/resources/RequestTarget');
const { runStatement } = require('#src/sqlEngine/index');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');

describe('estimateCondition AND intersection ignores filter-only legs', function () {
	describe('reducer arithmetic', () => {
		const fakeTable = {
			primaryKey: 'id',
			primaryStore: { estimatedEntryCount: 100, estimatedEntryCountExpires: Infinity },
		};
		const group = (counts, operator = 'and') => ({
			operator,
			conditions: counts.map((estimated_count) =>
				typeof estimated_count === 'object' ? estimated_count : { estimated_count }
			),
		});
		const estimate = (condition) => estimateCondition(fakeTable)(condition);

		it('intersects finite legs as before', () => {
			assert.strictEqual(estimate(group([10, 20])), 2);
			assert.strictEqual(estimate(group([25, 50])), 12.5);
		});

		it('skips an Infinity leg wherever it sits', () => {
			for (const counts of [
				[25, Infinity, 50],
				[Infinity, 25, 50],
				[25, 50, Infinity],
				[Infinity, 25, Infinity, 50, Infinity],
			])
				assert.strictEqual(estimate(group(counts)), 12.5, counts.join());
			assert.strictEqual(estimate(group([12, Infinity])), 12);
			assert.strictEqual(estimate(group([Infinity, 12])), 12);
		});

		it('keeps a zero estimate zero rather than NaN', () => {
			assert.strictEqual(estimate(group([0, Infinity, 4])), 0);
			assert.strictEqual(estimate(group([Infinity, 0, 4])), 0);
			assert.strictEqual(estimate(group([0, Infinity])), 0);
		});

		it('skips a NaN leg', () => {
			assert.strictEqual(estimate(group([12, NaN])), 12);
			assert.strictEqual(estimate(group([NaN, 12, Infinity])), 12);
		});

		it('stays Infinity when every leg is non-finite', () => {
			assert.strictEqual(estimate(group([Infinity, Infinity])), Infinity);
			assert.strictEqual(estimate(group([Infinity, NaN])), Infinity);
			assert.strictEqual(estimate(group([])), Infinity);
		});

		it('skips a nested group that is itself Infinity and uses one that is finite', () => {
			assert.strictEqual(estimate(group([25, group([Infinity, Infinity])])), 25);
			assert.strictEqual(estimate(group([group([25, Infinity]), 50, Infinity])), 12.5);
			assert.strictEqual(estimate(group([group([Infinity, 25]), group([50, Infinity])])), 12.5);
		});

		it('keeps a union Infinity when any branch is filter-only', () => {
			assert.strictEqual(estimate(group([25, Infinity], 'or')), Infinity);
			assert.strictEqual(estimate(group([25, 50], 'or')), 75);
		});
	});

	describe('conditionDrivesIndex across a relationship', () => {
		const relatedTable = {
			primaryKey: 'id',
			primaryStore: {},
			attributes: [{ name: 'id' }, { name: 'name' }, { name: 'note' }],
			indices: { name: {} },
		};
		const makeTable = (indices) => ({
			primaryKey: 'id',
			primaryStore: {},
			attributes: [
				{ name: 'owner', relationship: { from: 'ownerId' }, definition: { tableClass: relatedTable } },
				{ name: 'self', relationship: { from: 'id' }, definition: { tableClass: relatedTable } },
				{ name: 'items', relationship: { to: 'ownerId' }, elements: { definition: { tableClass: relatedTable } } },
				{ name: 'json' },
			],
			indices,
		});
		const drives = (indices, attribute, comparator = 'equals') =>
			conditionDrivesIndex(makeTable(indices), { attribute, comparator, value: 'v' });

		it('drives by an indexed attribute of the related table through the local join index', () => {
			assert.strictEqual(drives({ ownerId: {} }, ['owner', 'name']), true);
			assert.strictEqual(drives({}, ['items', 'name']), true);
			assert.strictEqual(drives({}, ['self', 'name']), true, 'a join from the primary key seeks the primary store');
		});

		it('does not drive by an unindexed related attribute, or without a usable local join index', () => {
			assert.strictEqual(drives({ ownerId: {} }, ['owner', 'note']), false);
			assert.strictEqual(drives({}, ['owner', 'name']), false);
			assert.strictEqual(drives({ ownerId: { isIndexing: true } }, ['owner', 'name']), false);
			assert.strictEqual(drives({ ownerId: {} }, ['owner', 'name'], 'in'), false);
		});

		it('does not drive by a plain nested JSON path', () => {
			assert.strictEqual(drives({}, ['json', 'k']), false);
			assert.strictEqual(drives({}, ['json', 'k'], 'ge'), false);
		});
	});

	describe('against real tables', function () {
		this.timeout(60000);

		let Table;
		let seed;
		let originalEngine;

		before(async () => {
			originalEngine = process.env.HARPER_SQL_ENGINE;
			process.env.HARPER_SQL_ENGINE = 'new';
			setupTestDBPath();
			setMainIsWorker(true);
			Table = table({
				table: 'EstimateFilterOnlySibling',
				database: 'test',
				schemaDefined: true,
				attributes: [
					{ name: 'id', type: 'ID', isPrimaryKey: true },
					{ name: 'a', type: 'String', indexed: true },
					{ name: 'b', type: 'Int', indexed: true },
					{ name: 'c', type: 'String', indexed: true },
					{ name: 'flag', type: 'String' },
					{ name: 'meta' },
				],
			});
			seed = [];
			for (let i = 0; i < 60; i++) {
				const row = { id: `r${String(i).padStart(2, '0')}`, c: i < 50 ? 'common' : 'rare', flag: 'none' };
				if (i % 2 === 0) row.meta = { k: i };
				if (i % 5 !== 0) row.a = i % 3 === 0 ? `x-${i}` : `plain-${i}`;
				if (i % 4 !== 0) row.b = i % 8;
				else if (i % 8 === 0) row.b = null;
				seed.push(row);
			}
		});

		beforeEach(reseed);

		after(() => {
			Table.primaryStore.estimatedEntryCountExpires = 0;
			if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
			else process.env.HARPER_SQL_ENGINE = originalEngine;
		});

		async function reseed() {
			for (const existing of await collect(Table.search({ allowFullScan: true }))) await Table.delete(existing.id);
			await Promise.all(seed.map((row) => Table.put({ ...row })));
			if (Table.indexingOperation) await Table.indexingOperation;
			// RocksDB's entry-count estimate grows with every delete-and-reput, which moves the table-fraction estimates
			Table.primaryStore.estimatedEntryCount = seed.length;
			Table.primaryStore.estimatedEntryCountExpires = Infinity;
		}

		async function collect(iterable) {
			const rows = [];
			for await (const row of iterable) rows.push(row);
			return rows;
		}

		async function ids(iterable) {
			return (await collect(iterable)).map((row) => row.id).sort();
		}

		const present = (value) => value !== null && value !== undefined;
		const notFive = (row) => present(row.b) && row.b !== 5;
		const notFiveOrSeven = (row) => present(row.b) && row.b !== 5 && row.b !== 7;
		const idsWhere = (predicate) =>
			seed
				.filter(predicate)
				.map((row) => row.id)
				.sort();

		const SQL_CASES = [
			{ where: `a IS NULL AND b != 5`, matches: (row) => !present(row.a) && notFive(row) },
			{ where: `b != 5 AND a IS NULL`, matches: (row) => !present(row.a) && notFive(row) },
			{ where: `a IS NULL AND b NOT IN (5, 7)`, matches: (row) => !present(row.a) && notFiveOrSeven(row) },
			{ where: `a LIKE '%x%' AND b != 5`, matches: (row) => present(row.a) && row.a.includes('x') && notFive(row) },
			{ where: `b != 5 AND a LIKE '%x%'`, matches: (row) => present(row.a) && row.a.includes('x') && notFive(row) },
			{
				where: `a LIKE '%x%' AND b NOT IN (5, 7)`,
				matches: (row) => present(row.a) && row.a.includes('x') && notFiveOrSeven(row),
			},
			{ where: `a LIKE '%1' AND b != 5`, matches: (row) => present(row.a) && row.a.endsWith('1') && notFive(row) },
			{
				where: `a LIKE '%1' AND b NOT IN (5, 7)`,
				matches: (row) => present(row.a) && row.a.endsWith('1') && notFiveOrSeven(row),
			},
			{ where: `NOT (a IS NOT NULL) AND b != 5`, matches: (row) => !present(row.a) && notFive(row) },
		];

		function runSql(sql) {
			const variant = sql.trim().split(/\s+/)[0].toLowerCase();
			const hdb_user = { username: 'test' };
			const statement = alasql.parse(sql).statements[0];
			return runStatement({
				variant,
				jsonMessage: { hdb_user, bypass_auth: true },
				statement: variant === 'select' ? statement : { statement, hdb_user },
			});
		}

		describe('SQL under allowFullScan: false', () => {
			it('rejects a lone filter-only condition, so the cases below cannot pass by scanning', async () => {
				await assert.rejects(runSql(`SELECT id FROM test.EstimateFilterOnlySibling WHERE a IS NULL`), /index/);
			});

			for (const { where, matches } of SQL_CASES) {
				it(`SELECT ... WHERE ${where}`, async () => {
					const expected = idsWhere(matches);
					assert.ok(expected.length > 0, 'the fixture must match something');
					const rows = await runSql(`SELECT id FROM test.EstimateFilterOnlySibling WHERE ${where}`);
					assert.deepStrictEqual(rows.map((row) => row.id).sort(), expected);
				});

				it(`UPDATE ... WHERE ${where}`, async () => {
					await runSql(`UPDATE test.EstimateFilterOnlySibling SET flag = 'changed' WHERE ${where}`);
					const changed = (await collect(Table.search({ allowFullScan: true }))).filter(
						(row) => row.flag === 'changed'
					);
					assert.deepStrictEqual(changed.map((row) => row.id).sort(), idsWhere(matches));
					assert.strictEqual((await collect(Table.search({ allowFullScan: true }))).length, seed.length);
				});

				it(`DELETE ... WHERE ${where}`, async () => {
					await runSql(`DELETE FROM test.EstimateFilterOnlySibling WHERE ${where}`);
					assert.deepStrictEqual(
						await ids(Table.search({ allowFullScan: true })),
						idsWhere((row) => !matches(row))
					);
				});
			}
		});

		describe('estimateCondition', () => {
			const equals = () => ({ attribute: 'c', value: 'rare' });
			const filterOnly = () => ({ attribute: 'a', comparator: 'contains', value: 'x' });
			const negated = () => ({ attribute: 'a', comparator: 'equals', value: 'x-3', negated: true });
			const notNull = () => ({ attribute: 'b', comparator: 'ne', value: null });
			const notFiveLeg = () => ({ attribute: 'b', comparator: 'ne', value: 5 });
			const estimate = (condition) => estimateCondition(Table)(condition);

			it('estimates a filter-only leg alone at Infinity', () => {
				assert.strictEqual(estimate(filterOnly()), Infinity);
				assert.strictEqual(estimate(negated()), Infinity);
				assert.strictEqual(estimate(notFiveLeg()), Infinity);
			});

			it('gives a group the finite estimate of its index-backed leg wherever a filter-only leg sits', () => {
				const finite = estimate(equals());
				assert.ok(Number.isFinite(finite));
				for (const conditions of [
					[equals(), filterOnly()],
					[filterOnly(), equals()],
					[negated(), equals(), filterOnly()],
				])
					assert.strictEqual(estimate({ conditions, operator: 'and' }), finite);
			});

			it('still intersects the finite legs of a group that also holds a filter-only leg', () => {
				const lead = estimate(equals());
				const other = estimate(notNull());
				const entries = estimatedEntryCount(Table.primaryStore);
				const expected = (lead * other) / entries;
				for (const conditions of [
					[equals(), filterOnly(), notNull()],
					[filterOnly(), equals(), notNull()],
					[equals(), notNull(), filterOnly()],
				])
					assert.strictEqual(estimate({ conditions, operator: 'and' }), expected);
			});

			it('estimates the != / NOT IN not-null group finite whichever order its legs are in', () => {
				const finite = estimate(notNull());
				for (const conditions of [
					[notFiveLeg(), notNull()],
					[notNull(), notFiveLeg()],
				])
					assert.strictEqual(estimate({ conditions, operator: 'and' }), finite);
			});

			it('keeps a group Infinity when every leg is filter-only, and a union Infinity when any branch is', () => {
				assert.strictEqual(
					estimate({ conditions: [filterOnly(), notFiveLeg(), negated()], operator: 'and' }),
					Infinity
				);
				assert.strictEqual(estimate({ conditions: [equals(), filterOnly()], operator: 'or' }), Infinity);
			});
		});

		describe('lead selection ranks a leg that can drive an index scan first', () => {
			const common = () => ({ attribute: 'c', value: 'common' });
			const contains = () => ({ attribute: 'a', comparator: 'contains', value: 'x' });
			const inLeg = () => ({ attribute: 'b', comparator: 'in', value: [3] });
			// searchByIndex answers each with a full scan
			const FULL_SCAN_LEGS = [
				['in', inLeg],
				['an empty starts_with', () => ({ attribute: 'a', comparator: 'starts_with', value: '' })],
				['an unindexed starts_with', () => ({ attribute: 'flag', comparator: 'starts_with', value: 'n' })],
				['an unindexed range', () => ({ attribute: 'flag', comparator: 'ge', value: 'n' })],
				['a nested JSON path range', () => ({ attribute: ['meta', 'k'], comparator: 'ge', value: 10 })],
			];
			const plan = async (conditions, options) =>
				(await Table.search({ conditions, allowFullScan: false, explain: true, ...options })).conditions;
			const run = (conditions) => ids(Table.search({ conditions, allowFullScan: false }));
			const scan = (conditions) => ids(Table.search({ conditions, allowFullScan: true, enforceExecutionOrder: true }));
			const intersect = async (...queries) => {
				const sets = await Promise.all(queries.map((conditions) => scan(conditions)));
				return sets.reduce((left, right) => left.filter((id) => right.includes(id)));
			};

			for (const [name, leg] of FULL_SCAN_LEGS) {
				it(`seeks c = common ahead of ${name}`, async () => {
					assert.ok(estimateCondition(Table)(leg()) < estimateCondition(Table)(common()), 'the leg estimates lower');
					for (const conditions of [
						[common(), leg()],
						[leg(), common()],
					]) {
						assert.strictEqual((await plan(conditions))[0].attribute, 'c');
						const expected = await intersect([leg()], [common()]);
						assert.ok(expected.length > 0, 'the fixture must match something');
						assert.deepStrictEqual(await run(conditions), expected);
					}
				});

				it(`seeks c = common ahead of a group pairing ${name} with a filter-only leg`, async () => {
					const conditions = () => [common(), { operator: 'and', conditions: [leg(), contains()] }];
					assert.strictEqual((await plan(conditions()))[0].attribute, 'c');
					assert.deepStrictEqual(await run(conditions()), await intersect([leg()], [contains()], [common()]));
				});

				it(`keeps the count: 'estimated' total of ${name}`, async () => {
					const estimate = estimateCondition(Table)(leg());
					assert.ok(Number.isFinite(estimate));
					const page = await Table.search({ conditions: [leg()], limit: 1, count: 'estimated', allowFullScan: true });
					assert.strictEqual(page.recordCount, Math.max(Math.round(estimate), page.length));
				});
			}

			it("keeps an `in` leg's estimate the sum of its values' index counts", () => {
				assert.strictEqual(
					estimateCondition(Table)({ attribute: 'b', comparator: 'in', value: [3, 5] }),
					Table.indices.b.getValuesCount(3) + Table.indices.b.getValuesCount(5)
				);
			});

			it('seeks a singleton primary-key path the estimator cannot size ahead of an `in` leg', async () => {
				const conditions = () => [inLeg(), { attribute: ['id'], value: 'r03' }];
				assert.deepStrictEqual((await plan(conditions()))[0].attribute, ['id']);
				assert.deepStrictEqual(await run(conditions()), ['r03']);
			});

			it('seeks c = common ahead of a union with a branch that cannot drive', async () => {
				const conditions = () => [
					common(),
					{ operator: 'or', conditions: [{ attribute: 'c', value: 'rare' }, inLeg()] },
				];
				assert.strictEqual((await plan(conditions()))[0].attribute, 'c');
				assert.deepStrictEqual(await run(conditions()), await intersect([inLeg()], [common()]));
			});

			it('still leads with a narrower union whose every branch drives', async () => {
				const union = () => ({
					operator: 'or',
					conditions: [
						{ attribute: 'c', value: 'rare' },
						{ attribute: 'b', value: 3 },
					],
				});
				assert.ok((await plan([common(), union()]))[0].conditions);
				assert.deepStrictEqual(await run([common(), union()]), await intersect([common()], [union()]));
			});

			it('does not lead with a null equality on an index that leaves nulls out', async () => {
				const indexNulls = Table.indices.b.indexNulls;
				Table.indices.b.indexNulls = false;
				try {
					assert.strictEqual((await plan([common(), { attribute: 'b', value: null }]))[0].attribute, 'c');
				} finally {
					Table.indices.b.indexNulls = indexNulls;
				}
			});

			it('still leads with a primary-key range, and with an indexed range on a store without estimateCount', async () => {
				const primaryKeyRange = () => ({ attribute: 'id', comparator: 'ge', value: 'r55' });
				const indexedRange = () => ({ attribute: 'a', comparator: 'starts_with', value: 'plain' });
				const index = Table.indices.a;
				const hadOwn = Object.hasOwn(index, 'estimateCount');
				const own = index.estimateCount;
				index.estimateCount = undefined;
				try {
					for (const range of [primaryKeyRange, indexedRange])
						for (const sibling of [contains, inLeg]) {
							const conditions = () => [sibling(), range()];
							assert.strictEqual((await plan(conditions()))[0].attribute, range().attribute);
							assert.deepStrictEqual(await run(conditions()), await intersect([sibling()], [range()]));
						}
				} finally {
					if (hadOwn) index.estimateCount = own;
					else delete index.estimateCount;
				}
			});

			it('keeps the written order under enforceExecutionOrder', async () => {
				assert.strictEqual((await plan([inLeg(), common()], { enforceExecutionOrder: true }))[0].attribute, 'b');
			});

			it('agrees with searchByIndex on which single conditions it can answer without a full scan', async () => {
				const LEAVES = [
					{ attribute: 'c', value: 'rare' },
					{ attribute: ['id'], value: 'r03' },
					{ attribute: 'id', comparator: 'ge', value: 'r55' },
					{ attribute: 'a', comparator: 'starts_with', value: 'plain' },
					{ attribute: 'b', comparator: 'between', value: [1, 3] },
					{ attribute: 'b', comparator: 'lt', value: 3 },
					{ attribute: 'b', comparator: 'ne', value: null },
					{ attribute: 'b', value: null },
					...FULL_SCAN_LEGS.map(([, leg]) => leg()),
					{ attribute: 'flag', value: 'none' },
					{ attribute: 'b', comparator: 'ne', value: 5 },
					{ attribute: 'a', comparator: 'contains', value: 'x' },
					{ attribute: 'a', comparator: 'ends_with', value: '1' },
					{ attribute: 'a', value: 'x-3', negated: true },
				];
				for (const leaf of LEAVES) {
					let answered = true;
					try {
						await run([{ ...leaf }]);
					} catch (error) {
						assert.ok([400, 403, 404].includes(error.statusCode), `${JSON.stringify(leaf)}: ${error.message}`);
						answered = false;
					}
					assert.strictEqual(conditionDrivesIndex(Table, { ...leaf }), answered, JSON.stringify(leaf));
				}
			});
		});

		describe('Table.search', () => {
			const filterOnly = () => ({ attribute: 'a', comparator: 'contains', value: 'x' });
			const negated = () => ({ attribute: 'a', comparator: 'equals', value: 'x-3', negated: true });
			const neGroup = () => ({
				operator: 'and',
				conditions: [
					{ attribute: 'b', comparator: 'ne', value: 5 },
					{ attribute: 'b', comparator: 'ne', value: null },
				],
			});
			const plan = (conditions) => Table.search({ conditions, allowFullScan: false, explain: true });

			it('leads with the != group ahead of a filter-only condition listed first, and drives it by the not-null leg', async () => {
				for (const first of [filterOnly(), negated()]) {
					const { conditions } = await plan([first, neGroup()]);
					assert.ok(conditions[0].conditions, 'the group leads');
					assert.strictEqual(conditions[0].conditions[0].value, null, 'the indexed not-null leg drives the group');
					assert.strictEqual(conditions[1].attribute, 'a');
				}
			});

			it('leads with the group holding the indexed leg ahead of a filter-only condition listed first', async () => {
				const group = { operator: 'and', conditions: [filterOnly(), { attribute: 'c', value: 'rare' }] };
				const { conditions } = await plan([filterOnly(), group]);
				assert.ok(conditions[0].conditions, 'the group leads');
				assert.strictEqual(conditions[0].conditions[0].attribute, 'c', 'the indexed leg leads inside the group');
			});

			it('returns the rows of a filter-only condition followed by a != group', async () => {
				assert.deepStrictEqual(
					await ids(Table.search({ conditions: [filterOnly(), neGroup()], allowFullScan: false })),
					idsWhere((row) => present(row.a) && row.a.includes('x') && notFive(row))
				);
				assert.deepStrictEqual(
					await ids(Table.search({ conditions: [negated(), neGroup()], allowFullScan: false })),
					idsWhere((row) => row.a !== 'x-3' && notFive(row))
				);
			});

			it('answers a nested FIQL AND group under allowFullScan: false', async () => {
				const search = (query) => {
					const target = new RequestTarget(query);
					target.allowFullScan = false;
					return ids(Table.search(target));
				};
				const withX = (row) => present(row.a) && row.a.includes('x');
				const found = await search('?a=ct=x&(c=common&a=ct=-)');
				assert.ok(found.length > 0);
				assert.deepStrictEqual(
					found,
					idsWhere((row) => withX(row) && row.c === 'common' && row.a.includes('-'))
				);
				assert.deepStrictEqual(
					await search('?a=ct=x&(c=rare&a=ct=l)'),
					idsWhere((row) => withX(row) && row.c === 'rare' && row.a.includes('l'))
				);
			});

			it('drives a nested FIQL AND group by its indexed leg', async () => {
				const target = new RequestTarget('?a=ct=x&(c=rare&a=ct=l)');
				target.allowFullScan = false;
				target.explain = true;
				const { conditions } = await Table.search(target);
				assert.ok(conditions[0].conditions, 'the group leads');
				assert.strictEqual(conditions[0].conditions[0].attribute, 'c');
			});

			it('keeps rejecting a query whose conditions are all filter-only, or a union with a filter-only branch', async () => {
				const rejected = (error) => error.statusCode === 403;
				const search = (conditions) => async () => ids(Table.search({ conditions, allowFullScan: false }));
				await assert.rejects(search([filterOnly(), negated()]), rejected);
				await assert.rejects(search([filterOnly()]), rejected);
				await assert.rejects(
					search([{ operator: 'and', conditions: [filterOnly(), negated()] }, filterOnly()]),
					rejected
				);
				await assert.rejects(
					search([{ operator: 'or', conditions: [{ attribute: 'c', value: 'rare' }, filterOnly()] }, filterOnly()]),
					rejected
				);
			});

			it('filters by a rebuilding index leg while the finite sibling drives', async () => {
				const group = {
					operator: 'and',
					conditions: [
						{ attribute: 'c', value: 'rare' },
						{ attribute: 'b', comparator: 'ne', value: null },
					],
				};
				Table.indices.c.isIndexing = true;
				try {
					assert.deepStrictEqual(
						await ids(Table.search({ conditions: [filterOnly(), group], allowFullScan: false })),
						idsWhere((row) => present(row.a) && row.a.includes('x') && row.c === 'rare' && present(row.b))
					);
				} finally {
					Table.indices.c.isIndexing = false;
				}
			});

			describe('count: estimated', () => {
				const rare = () => ({ attribute: 'c', value: 'rare' });

				for (const [name, conditions] of [
					['an indexed leg then a filter-only leg', () => [rare(), filterOnly()]],
					['a filter-only leg then an indexed leg', () => [filterOnly(), rare()]],
					['a filter-only leg then a != group', () => [filterOnly(), neGroup()]],
					['a negated leg then a != group', () => [negated(), neGroup()]],
				])
					it(`reports a finite non-exact total for ${name}`, async () => {
						const page = await Table.search({
							conditions: conditions(),
							limit: 5,
							count: 'estimated',
							allowFullScan: false,
						});
						assert.ok(Number.isFinite(page.recordCount), `recordCount ${page.recordCount} is a number`);
						assert.strictEqual(page.recordCountExact, false);
					});

				it('still reports an unknown total behind an opaque row filter', async () => {
					const page = await Table.search({
						conditions: [rare(), filterOnly()],
						limit: 5,
						count: 'estimated',
						allowFullScan: false,
						vectorFilter: () => true,
					});
					assert.strictEqual(page.recordCount, null);
				});
			});
		});
	});
});
