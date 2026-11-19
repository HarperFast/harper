// harper#3208

require('../testUtils');
const assert = require('node:assert');
const alasql = require('alasql');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { evaluateSQL } = require('#src/sqlTranslator/index');
const { runWithOperationAuthorizationBypass } = require('#src/server/serverHelpers/operationAuthorizationState');
const mutation = require('#src/sqlEngine/executor/runMutation');
const { normalizeStatement, bind, buildLogicalPlan } = require('#src/sqlEngine/index');
const { optimize } = require('#src/sqlEngine/optimizer/optimize');
const { transaction } = require('#src/resources/transaction');
const configUtils = require('#src/config/configUtils');
const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');

const TABLE = 'test.SqlFalsyPredicate';

const GROUPS = {
	truth: {
		zero: 0,
		negzero: -0,
		one: 1,
		nan: NaN,
		empty: '',
		blank: '   ',
		str0: '0',
		x: 'x',
		f: false,
		t: true,
		bigzero: 0n,
		bigone: 1n,
		nul: null,
		omitted: undefined,
	},
	cmp: {
		neg: -1,
		zero: 0,
		one: 1,
		two: 2,
		inf: Infinity,
		empty: '',
		blank: '   ',
		ws: '\t\n',
		x: 'x',
		dashx: '-x',
		nul: null,
		omitted: undefined,
	},
	nan: { nan: NaN, zero: 0, one: 1, inf: Infinity },
};
const SEED = Object.entries(GROUPS).flatMap(([grp, values]) =>
	Object.entries(values).map(([name, value]) => {
		const record = { id: `${grp}.${name}`, grp, note: 'seed' };
		if (value !== undefined) record.v = record.iv = value;
		return record;
	})
);
SEED.push(
	{ id: 'h0.a', grp: 'h0', n: 1, note: 'seed' },
	{ id: 'h0.b', grp: 'h0', n: -1, note: 'seed' },
	{ id: 'h3.a', grp: 'h3', n: 1, note: 'seed' },
	{ id: 'h3.b', grp: 'h3', n: 2, note: 'seed' }
);
const ALL_IDS = SEED.map((record) => record.id).sort();

const sorted = (ids) => [...ids].sort();
const idsOf = (grp, names) => sorted(names.map((name) => `${grp}.${name}`));

const TRUTHY = ['bigone', 'blank', 'one', 'str0', 't', 'x'];
const FALSY_NOT_NULL = ['bigzero', 'empty', 'f', 'nan', 'negzero', 'zero'];

const TEXT = ['blank', 'dashx', 'empty', 'ws', 'x'];
const CMP_CASES = [
	{ where: '$ = 0', expected: ['zero'], drives: true },
	{ where: '$ <> 0', expected: ['neg', 'one', 'two', 'inf', ...TEXT] },
	{ where: '$ IN (0, 2)', expected: ['zero', 'two'], drives: true },
	{ where: '$ NOT IN (0, 2)', expected: ['neg', 'one', 'inf', ...TEXT] },
	{ where: '$ < 1', expected: ['neg', 'zero'], drives: true },
	{ where: '$ <= 0', expected: ['neg', 'zero'], drives: true },
	{ where: '$ > 1', expected: ['two', 'inf', ...TEXT], drives: true },
	{ where: '$ >= 0', expected: ['zero', 'one', 'two', 'inf', ...TEXT], drives: true },
	{ where: '$ BETWEEN 0 AND 1', expected: ['zero', 'one'], drives: true },
	{ where: '$ NOT BETWEEN 0 AND 1', expected: ['neg', 'two', 'inf', ...TEXT] },
	{ where: 'NOT ($ < 1)', expected: ['one', 'two', 'inf', ...TEXT], drives: true },
	{ where: 'NOT ($ >= 1)', expected: ['neg', 'zero'], drives: true },
	{ where: "$ > ''", expected: ['blank', 'dashx', 'ws', 'x'], drives: true },
	{ where: "$ < 'b'", expected: ['neg', 'zero', 'one', 'two', 'inf', 'blank', 'dashx', 'empty', 'ws'], drives: true },
];
const RESIDUAL_CASES = [
	{ where: '0 = v', expected: ['zero'] },
	{ where: '1 > v', expected: ['neg', 'zero'] },
	{ where: 'v + 0 = 0', expected: ['zero'] },
	{ where: "v + 0 > '0'", expected: ['one', 'two', 'inf'] },
	{ where: 'v * 1 >= 0', expected: ['zero', 'one', 'two', 'inf'] },
	{ where: "v < '0'", expected: ['neg', 'blank', 'dashx', 'empty', 'ws'] },
];

describe('SQL predicates over falsy, blank and NaN values', function () {
	this.timeout(120000);

	let T;
	let originalEngine;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		originalEngine = process.env.HARPER_SQL_ENGINE;
		mutation._setTransactionRunner(transaction);
		T = table({
			table: 'SqlFalsyPredicate',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'grp', indexed: true },
				{ name: 'v' },
				{ name: 'iv', indexed: true },
				{ name: 'n' },
				{ name: 'note' },
			],
		});
	});

	beforeEach(() => reseed());

	after(() => {
		mutation._setTransactionRunner(null);
		if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
		else process.env.HARPER_SQL_ENGINE = originalEngine;
	});

	async function reseed() {
		let last;
		for (const record of SEED) last = T.put({ ...record });
		await last;
		if (T.indexingOperation) await T.indexingOperation;
	}

	function sql(engine, text) {
		process.env.HARPER_SQL_ENGINE = engine;
		return runWithOperationAuthorizationBypass(
			true,
			() =>
				new Promise((resolve, reject) =>
					evaluateSQL({ sql: text, hdb_user: { username: 'test' } }, (error, result) =>
						error ? reject(error) : resolve(result)
					)
				)
		);
	}

	async function storedRows() {
		const rows = {};
		for await (const record of T.search({ select: ['id', 'note'] })) rows[record.id] = record.note;
		return rows;
	}

	async function selected(engine, where) {
		return sorted((await sql(engine, `SELECT id FROM ${TABLE} WHERE ${where}`)).map((row) => row.id));
	}

	async function updated(engine, where) {
		await reseed();
		const result = await sql(engine, `UPDATE ${TABLE} SET note = 'hit' WHERE ${where}`);
		const rows = await storedRows();
		const stored = Object.keys(rows).filter((id) => rows[id] === 'hit');
		return { reported: sorted(result.update_hashes), stored: sorted(stored) };
	}

	async function deleted(engine, where) {
		await reseed();
		const result = await sql(engine, `DELETE FROM ${TABLE} WHERE ${where}`);
		const survivors = Object.keys(await storedRows());
		return {
			reported: sorted(result.deleted_hashes),
			stored: ALL_IDS.filter((id) => !survivors.includes(id)),
		};
	}

	async function assertMatches(engine, where, expected) {
		assert.deepStrictEqual(await selected(engine, where), expected, `SELECT ${where}`);
		const update = await updated(engine, where);
		assert.deepStrictEqual(update.reported, expected, `UPDATE ${where} reported`);
		assert.deepStrictEqual(update.stored, expected, `UPDATE ${where} stored`);
		const removal = await deleted(engine, where);
		assert.deepStrictEqual(removal.reported, expected, `DELETE ${where} reported`);
		assert.deepStrictEqual(removal.stored, expected, `DELETE ${where} stored`);
	}

	describe('a bare value is a predicate only when it is truthy', () => {
		for (const engine of ['legacy', 'auto', 'new']) {
			it(`${engine}: WHERE v selects, updates and deletes only truthy values`, async () => {
				await assertMatches(engine, "grp = 'truth' AND v", idsOf('truth', TRUTHY));
			});
		}

		for (const engine of ['auto', 'new']) {
			it(`${engine}: NOT v selects the non-null falsy values, NaN included`, async () => {
				await assertMatches(engine, "grp = 'truth' AND NOT v", idsOf('truth', FALSY_NOT_NULL));
			});

			it(`${engine}: v OR false rejects NaN`, async () => {
				await assertMatches(engine, "grp = 'truth' AND (v OR false)", idsOf('truth', TRUTHY));
			});

			it(`${engine}: LIMIT and OFFSET count only rows the predicate admits`, async () => {
				const ids = async (suffix) =>
					(await sql(engine, `SELECT id FROM ${TABLE} WHERE grp = 'truth' AND v ORDER BY id ${suffix}`)).map(
						(row) => row.id
					);
				assert.deepStrictEqual(await ids('LIMIT 2'), ['truth.bigone', 'truth.blank']);
				assert.deepStrictEqual(await ids('LIMIT 2 OFFSET 1'), ['truth.blank', 'truth.one']);
			});

			it(`${engine}: HAVING drops a group whose value is 0`, async () => {
				const rows = await sql(
					engine,
					`SELECT grp, SUM(n) AS s FROM ${TABLE} WHERE grp IN ('h0', 'h3') GROUP BY grp HAVING SUM(n) + 0`
				);
				assert.deepStrictEqual(rows, [{ grp: 'h3', s: 3 }]);
			});
		}
	});

	describe('comparisons with blank and non-numeric strings', () => {
		for (const engine of ['auto', 'new']) {
			for (const { where, expected } of CMP_CASES) {
				const rows = idsOf('cmp', expected);
				it(`${engine}: ${where.replaceAll('$', 'v')} on an unindexed column`, async () => {
					await assertMatches(engine, `grp = 'cmp' AND ${where.replaceAll('$', 'v')}`, rows);
				});
				it(`${engine}: ${where.replaceAll('$', 'iv')} on an indexed column selects the same rows`, async () => {
					await assertMatches(engine, `grp = 'cmp' AND ${where.replaceAll('$', 'iv')}`, rows);
				});
			}

			it(`${engine}: an indexed comparison leading the scan selects the same rows`, async () => {
				for (const { where, expected, drives } of CMP_CASES) {
					if (!drives) continue;
					const found = await selected(engine, where.replaceAll('$', 'iv'));
					assert.deepStrictEqual(
						found.filter((id) => id.startsWith('cmp.')),
						idsOf('cmp', expected),
						where
					);
				}
			});

			for (const { where, expected } of RESIDUAL_CASES) {
				it(`${engine}: ${where}`, async () => {
					await assertMatches(engine, `grp = 'cmp' AND ${where}`, idsOf('cmp', expected));
				});
			}
		}

		for (const [predicate, expected] of [
			['= 0', ['zero']],
			['IN (0, 2)', ['zero', 'two']],
		]) {
			it(`legacy: v ${predicate} selects the same rows`, async () => {
				assert.deepStrictEqual(await selected('legacy', `grp = 'cmp' AND v ${predicate}`), idsOf('cmp', expected));
			});
		}
	});

	describe('NaN has no order', () => {
		const NAN_CASES = [
			['v > 0', ['one', 'inf']],
			['v >= 0', ['zero', 'one', 'inf']],
			['v < 1', ['zero']],
			['NOT (v < 1)', ['one', 'inf']],
			['v <> 0', ['nan', 'one', 'inf']],
			['v = v', ['zero', 'one', 'inf']],
			['v <= v', ['zero', 'one', 'inf']],
			['v BETWEEN 0 AND 1', ['zero', 'one']],
			['v NOT BETWEEN 0 AND 1', ['inf']],
		];
		for (const engine of ['auto', 'new']) {
			for (const [where, expected] of NAN_CASES) {
				it(`${engine}: ${where}`, async () => {
					await assertMatches(engine, `grp = 'nan' AND ${where}`, idsOf('nan', expected));
				});
			}

			it(`${engine}: an indexed range still matches a stored NaN, which the index sorts above numbers`, async () => {
				await assertMatches(engine, `grp = 'nan' AND iv > 0`, idsOf('nan', ['inf', 'nan', 'one']));
				await reseed();
				await assertMatches(engine, `grp = 'nan' AND v > 0`, idsOf('nan', ['inf', 'one']));
			});

			it(`${engine}: a projected comparison is NULL for NaN and agrees with the WHERE row set`, async () => {
				const rows = await sql(
					engine,
					`SELECT id, NOT (v < 1) AS r, v BETWEEN 0 AND 1 AS b, v NOT BETWEEN 0 AND 1 AS nb, v <= v AS s FROM ${TABLE} WHERE grp = 'nan'`
				);
				const byId = Object.fromEntries(rows.map(({ id, ...rest }) => [id, rest]));
				assert.deepStrictEqual(byId, {
					'nan.nan': { r: null, b: null, nb: null, s: null },
					'nan.zero': { r: false, b: true, nb: false, s: true },
					'nan.one': { r: true, b: true, nb: false, s: true },
					'nan.inf': { r: true, b: false, nb: true, s: true },
				});
				const admitted = sorted(rows.filter((row) => row.r === true).map((row) => row.id));
				assert.deepStrictEqual(admitted, await selected(engine, `grp = 'nan' AND NOT (v < 1)`));
			});
		}
	});

	describe('arithmetic on a blank string', () => {
		for (const engine of ['auto', 'new']) {
			it(`${engine}: is NaN, in a projection and in an UPDATE assignment`, async () => {
				const rows = await sql(engine, `SELECT id, v * 2 AS d FROM ${TABLE} WHERE id IN ('cmp.empty', 'cmp.one')`);
				const byId = Object.fromEntries(rows.map((row) => [row.id, row.d]));
				assert.ok(Number.isNaN(byId['cmp.empty']), `projected ${byId['cmp.empty']}`);
				assert.strictEqual(byId['cmp.one'], 2);
				await sql(engine, `UPDATE ${TABLE} SET note = v * 2 WHERE id IN ('cmp.empty', 'cmp.one')`);
				assert.ok(Number.isNaN((await T.get('cmp.empty')).note));
				assert.strictEqual((await T.get('cmp.one')).note, 2);
			});
		}
	});
});

describe('SQL join predicates over falsy and NaN values', function () {
	this.timeout(120000);

	let originalEngine;
	let originalAllowFullScan;

	const OUTER = { nan: NaN, one: 1, zero: 0, f: false, e: '', two: 2 };
	const INNER = [
		['nan', NaN, 1],
		['one0', 1, 0],
		['oneE', 1, ''],
		['oneN', 1, NaN],
		['oneT', 1, 1],
		['zero', 0, 1],
		['f', false, 1],
		['e', '', 1],
		['two0', 2, 0],
		['twoE', 2, ''],
	];
	const EQUI = ['e:e', 'f:f', 'one:one0', 'one:oneE', 'one:oneN', 'one:oneT', 'two:two0', 'two:twoE', 'zero:zero'];
	const EQUI_FLAG = ['e:e', 'f:f', 'one:oneT', 'zero:zero'];
	const TRUTHY_INNER = ['e', 'f', 'nan', 'oneT', 'zero'];

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		originalEngine = process.env.HARPER_SQL_ENGINE;
		originalAllowFullScan = configUtils.getConfigValue(CONFIG_PARAMS.SQL_ALLOWFULLSCAN);
		const Outer = table({
			table: 'SqlFalsyJoinOuter',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'grp', indexed: true }, { name: 'k' }, { name: 'none' }],
		});
		const Inner = table({
			table: 'SqlFalsyJoinInner',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'grp', indexed: true },
				{ name: 'ik', indexed: true },
				{ name: 'uk' },
				{ name: 'flag' },
			],
		});
		for (const [id, k] of Object.entries(OUTER)) await Outer.put({ id, grp: 'g', k, none: null });
		for (const [id, k, flag] of INNER) await Inner.put({ id, grp: 'h', ik: k, uk: k, flag });
		for (const t of [Outer, Inner]) if (t.indexingOperation) await t.indexingOperation;
	});

	afterEach(() => {
		configUtils.updateConfigObject(CONFIG_PARAMS.SQL_ALLOWFULLSCAN, originalAllowFullScan);
	});

	after(() => {
		if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
		else process.env.HARPER_SQL_ENGINE = originalEngine;
	});

	function sql(engine, text) {
		process.env.HARPER_SQL_ENGINE = engine;
		return runWithOperationAuthorizationBypass(
			true,
			() =>
				new Promise((resolve, reject) =>
					evaluateSQL({ sql: text, hdb_user: { username: 'test' } }, (error, result) =>
						error ? reject(error) : resolve(result)
					)
				)
		);
	}

	function joinStrategies(text) {
		const plan = optimize(buildLogicalPlan(bind(normalizeStatement(alasql.parse(text).statements[0], 'select'), {})));
		const strategies = [];
		(function walk(node) {
			if (node.kind === 'Join') strategies.push(node.strategy);
			for (const key of ['input', 'left', 'right']) if (node[key]) walk(node[key]);
		})(plan);
		return strategies;
	}

	const FROM = 'test.SqlFalsyJoinOuter a';
	const INNER_TABLE = 'test.SqlFalsyJoinInner b';
	const CASES = [
		{
			name: 'indexNL never probes a NaN outer key',
			strategy: 'indexNL',
			sql: `SELECT a.id AS aid, b.id AS bid FROM ${FROM} INNER JOIN ${INNER_TABLE} ON a.k = b.ik WHERE a.grp = 'g'`,
			expected: EQUI,
		},
		{
			name: 'indexNL LEFT null-fills a NaN outer key once',
			strategy: 'indexNL',
			sql: `SELECT a.id AS aid, b.id AS bid FROM ${FROM} LEFT JOIN ${INNER_TABLE} ON a.k = b.ik WHERE a.grp = 'g'`,
			expected: [...EQUI, 'nan:null'],
		},
		{
			name: 'indexNL ON residual rejects falsy values',
			strategy: 'indexNL',
			sql: `SELECT a.id AS aid, b.id AS bid FROM ${FROM} INNER JOIN ${INNER_TABLE} ON a.k = b.ik AND b.flag WHERE a.grp = 'g'`,
			expected: EQUI_FLAG,
		},
		{
			name: 'indexNL LEFT null-fills once when every candidate is rejected',
			strategy: 'indexNL',
			sql: `SELECT a.id AS aid, b.id AS bid FROM ${FROM} LEFT JOIN ${INNER_TABLE} ON a.k = b.ik AND b.flag WHERE a.grp = 'g'`,
			expected: [...EQUI_FLAG, 'nan:null', 'two:null'],
		},
		{
			name: 'indexNL inner-side WHERE rejects falsy values',
			strategy: 'indexNL',
			sql: `SELECT a.id AS aid, b.id AS bid FROM ${FROM} INNER JOIN ${INNER_TABLE} ON a.k = b.ik WHERE a.grp = 'g' AND b.flag`,
			expected: EQUI_FLAG,
		},
		{
			name: 'hash ON residual rejects falsy values',
			strategy: 'hash',
			sql: `SELECT a.id AS aid, b.id AS bid FROM ${FROM} INNER JOIN ${INNER_TABLE} ON a.k = b.uk AND COALESCE(a.none, b.flag) WHERE a.grp = 'g' AND b.grp = 'h'`,
			expected: EQUI_FLAG,
		},
		{
			name: 'hash LEFT null-fills once when every candidate is rejected',
			strategy: 'hash',
			allowFullScan: true,
			sql: `SELECT a.id AS aid, b.id AS bid FROM ${FROM} LEFT JOIN ${INNER_TABLE} ON a.k = b.uk AND COALESCE(a.none, b.flag) WHERE a.grp = 'g'`,
			expected: [...EQUI_FLAG, 'nan:null', 'two:null'],
		},
		{
			name: 'nested-loop ON rejects falsy values',
			strategy: 'nestedLoop',
			sql: `SELECT a.id AS aid, b.id AS bid FROM ${FROM} INNER JOIN ${INNER_TABLE} ON COALESCE(a.none, b.flag) WHERE a.grp = 'g' AND b.grp = 'h'`,
			expected: Object.keys(OUTER).flatMap((outer) => TRUTHY_INNER.map((inner) => `${outer}:${inner}`)),
		},
		{
			name: 'nested-loop LEFT null-fills once when every candidate is rejected',
			strategy: 'nestedLoop',
			allowFullScan: true,
			sql: `SELECT a.id AS aid, b.id AS bid FROM ${FROM} LEFT JOIN ${INNER_TABLE} ON COALESCE(a.none, b.flag) AND b.flag = 0 WHERE a.grp = 'g'`,
			expected: Object.keys(OUTER).map((outer) => `${outer}:null`),
		},
	];

	for (const engine of ['auto', 'new']) {
		for (const { name, strategy, allowFullScan, sql: text, expected } of CASES) {
			it(`${engine}: ${name}`, async () => {
				if (allowFullScan) configUtils.updateConfigObject(CONFIG_PARAMS.SQL_ALLOWFULLSCAN, true);
				const rows = await sql(engine, text);
				assert.deepStrictEqual(sorted(rows.map((row) => `${row.aid}:${row.bid}`)), sorted(expected));
				assert.deepStrictEqual(joinStrategies(text), [strategy]);
			});
		}
	}
});
