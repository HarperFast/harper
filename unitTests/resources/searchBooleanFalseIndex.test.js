require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { estimateCondition } = require('#src/resources/search');
const { setMainIsWorker } = require('#js/server/threads/manageThreads');
const alasql = require('alasql');
const router = require('#src/sqlEngine/router');
const binder = require('#src/sqlEngine/binder/bind');

// ordered-binary sorts null (0x00) < false (0x06) < true (0x07). A scan that opens its lower bound at
// `true` therefore skips every indexed `false`.
describe('searchByIndex over an indexed boolean attribute', () => {
	const FALSE_ROWS = 600;
	const TRUE_ROWS = 50;
	let T;

	before(async function () {
		this.timeout(60000);
		setupTestDBPath();
		setMainIsWorker(true);
		T = table({
			table: 'BooleanFalseIndexTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'flag', type: 'Boolean', indexed: true },
			],
		});
		let last;
		for (let i = 0; i < FALSE_ROWS; i++) last = T.put({ id: `f${i}`, flag: false });
		for (let i = 0; i < TRUE_ROWS; i++) last = T.put({ id: `t${i}`, flag: true });
		last = T.put({ id: 'n', flag: null });
		await last;
		await T.primaryStore.flush?.();
		await T.indices.flag.flush?.();
	});

	after(() => {
		T.dropTable();
	});

	async function ids(query) {
		const found = [];
		for await (const record of T.search({ select: ['id'], ...query })) found.push(record.id);
		return found;
	}
	const falseIds = Array.from({ length: FALSE_ROWS }, (_, i) => `f${i}`).sort();
	const trueIds = Array.from({ length: TRUE_ROWS }, (_, i) => `t${i}`).sort();

	for (const [name, condition, expected] of [
		['lt true', { attribute: 'flag', comparator: 'lt', value: true }, falseIds],
		['le false', { attribute: 'flag', comparator: 'le', value: false }, falseIds],
		['le true', { attribute: 'flag', comparator: 'le', value: true }, [...falseIds, ...trueIds]],
		['in (false)', { attribute: 'flag', comparator: 'in', value: [false] }, falseIds],
		['in (false, true)', { attribute: 'flag', comparator: 'in', value: [false, true] }, [...falseIds, ...trueIds]],
		['not (ge true)', { attribute: 'flag', comparator: 'ge', value: true, negated: true }, [...falseIds, 'n']],
	]) {
		it(`${name} includes the false rows`, async () => {
			assert.deepStrictEqual((await ids({ conditions: [condition] })).sort(), [...expected].sort());
		});
	}

	it('ne true includes the false rows', async () => {
		const found = await ids({ conditions: [{ attribute: 'flag', comparator: 'ne', value: true }] });
		for (const id of falseIds) assert.ok(found.includes(id), `${id} missing from ne true`);
		assert.ok(!found.some((id) => id.startsWith('t')), 'ne true returned a true row');
	});

	it('ne null returns every non-null row', async () => {
		const found = await ids({ conditions: [{ attribute: 'flag', comparator: 'ne', value: null }] });
		assert.deepStrictEqual(found.sort(), [...falseIds, ...trueIds].sort());
	});

	it('sort ascending and descending include the false rows', async () => {
		const withSort = (descending) =>
			ids({
				conditions: [{ attribute: 'flag', comparator: 'le', value: true }],
				sort: { attribute: 'flag', descending },
			});
		const ascending = await withSort(false);
		assert.strictEqual(ascending.length, FALSE_ROWS + TRUE_ROWS);
		assert.ok(ascending[0].startsWith('f') && ascending.at(-1).startsWith('t'), 'ascending order');
		const descending = await withSort(true);
		assert.strictEqual(descending.length, FALSE_ROWS + TRUE_ROWS);
		assert.ok(descending[0].startsWith('t') && descending.at(-1).startsWith('f'), 'descending order');
	});

	it('sort alone includes the false rows', async () => {
		for (const descending of [false, true]) {
			const found = await ids({ sort: { attribute: 'flag', descending } });
			for (const id of falseIds) assert.ok(found.includes(id), `${id} missing from sort(descending=${descending})`);
		}
	});

	it('contains and ends_with scan the false rows', async () => {
		// boolean false stringifies to 'false'; the predicate, not the scan bound, decides the match
		const matching = async (comparator, value) =>
			(await ids({ conditions: [{ attribute: 'flag', comparator, value }] })).sort();
		assert.deepStrictEqual(await matching('contains', 'alse'), falseIds);
		assert.deepStrictEqual(await matching('ends_with', 'lse'), falseIds);
	});

	it('reverse lt/le sorts and pages through the false rows', async () => {
		for (const comparator of ['lt', 'le']) {
			const value = comparator === 'lt' ? true : false;
			const all = await ids({
				conditions: [{ attribute: 'flag', comparator, value }],
				sort: { attribute: 'flag', descending: true },
			});
			assert.strictEqual(all.length, FALSE_ROWS, `${comparator} descending`);
			const page = await ids({
				conditions: [{ attribute: 'flag', comparator, value }],
				sort: { attribute: 'flag', descending: true },
				offset: FALSE_ROWS - 5,
				limit: 10,
			});
			assert.strictEqual(page.length, 5, `${comparator} descending offset`);
		}
	});

	it('estimates a false-only range as non-empty', function () {
		if (typeof T.indices.flag.estimateCount !== 'function') return this.skip();
		const estimate = estimateCondition(T);
		for (const comparator of ['lt', 'le']) {
			const estimated = estimate({ attribute: 'flag', comparator, value: comparator === 'lt' ? true : false });
			assert.ok(estimated > FALSE_ROWS / 10, `${comparator} estimated ${estimated} for ${FALSE_ROWS} false rows`);
		}
	});
});

describe('SQL over an indexed boolean attribute', () => {
	let T;
	let originalEngine;

	before(() => {
		setupTestDBPath();
		setMainIsWorker(true);
		originalEngine = process.env.HARPER_SQL_ENGINE;
		process.env.HARPER_SQL_ENGINE = 'new';
		T = table({
			table: 'BooleanFalseSqlTest',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'flag', type: 'Boolean', indexed: true },
				{ name: 'note' },
			],
		});
		binder._setDatabasesLoader(() => ({ test: { BooleanFalseSqlTest: T } }));
	});

	beforeEach(async () => {
		for (const [id, flag] of [
			['f1', false],
			['f2', false],
			['t1', true],
			['n1', null],
		])
			await T.put({ id, flag, note: 'seed' });
	});

	afterEach(async () => {
		for await (const { id } of T.search({ select: ['id'] })) await T.delete(id);
	});

	after(() => {
		binder._setDatabasesLoader(null);
		if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
		else process.env.HARPER_SQL_ENGINE = originalEngine;
		T.dropTable();
	});

	function runSql(sql) {
		return new Promise((resolve, reject) => {
			const ast = alasql.parse(sql).statements[0];
			const variant = sql.trim().split(/\s+/)[0].toLowerCase();
			const hdb_user = { username: 'test' };
			router.route(
				{
					variant,
					jsonMessage: { hdb_user, bypass_auth: true },
					statement: variant === 'select' ? ast : { statement: ast, hdb_user },
					legacy: () => reject(new Error('legacy fallback should not be invoked')),
				},
				(err, data) => (err ? reject(err) : resolve(data))
			);
		});
	}
	const remaining = async () => {
		const found = {};
		for await (const record of T.search({ select: ['id', 'note'] })) found[record.id] = record.note;
		return found;
	};

	it('SELECT with lt/le reaches the false rows', async () => {
		for (const where of ['flag < true', 'flag <= false']) {
			const rows = await runSql(`SELECT id FROM test.BooleanFalseSqlTest WHERE ${where}`);
			assert.deepStrictEqual(rows.map((row) => row.id).sort(), ['f1', 'f2'], where);
		}
	});

	it('UPDATE ... WHERE flag <= false changes exactly the false rows', async () => {
		await runSql("UPDATE test.BooleanFalseSqlTest SET note = 'updated' WHERE flag <= false");
		assert.deepStrictEqual(await remaining(), { f1: 'updated', f2: 'updated', t1: 'seed', n1: 'seed' });
	});

	it('DELETE ... WHERE flag < true deletes exactly the false rows', async () => {
		await runSql('DELETE FROM test.BooleanFalseSqlTest WHERE flag < true');
		assert.deepStrictEqual(await remaining(), { t1: 'seed', n1: 'seed' });
	});
});
