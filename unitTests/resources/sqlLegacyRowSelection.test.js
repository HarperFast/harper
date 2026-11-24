// harper#4552: legacy SQL lost WHERE terms nested more than 100 levels deep, and UPDATE and DELETE re-parsed their
// WHERE from text, which turned `IS NOT NULL` into `IS (NOT NULL)`.

require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { evaluateSQL } = require('#src/sqlTranslator/index');
const { runWithOperationAuthorizationBypass } = require('#src/server/serverHelpers/operationAuthorizationState');
const mutation = require('#src/sqlEngine/executor/runMutation');
const { transaction } = require('#src/resources/transaction');

const TABLE = 'test.SqlLegacyRowSelection';
const ROWS = 160;
// ids 1-9 carry the null and falsy values; the rest hold their id
const NULLISH = { 1: null, 2: 0, 3: false, 4: '', 5: 1, 6: true, 7: undefined, 8: 'x', 9: 2 };
const SEED = Array.from({ length: ROWS }, (_, i) => {
	const id = i + 1;
	const record = { id, grp: id in NULLISH ? 'nullish' : 'plain', name: `n${id}`, note: 'seed' };
	const v = id in NULLISH ? NULLISH[id] : id;
	if (v !== undefined) record.v = v;
	return record;
});
const ALL_IDS = SEED.map((record) => record.id);
const NOT_NULL = [2, 3, 4, 5, 6, 8, 9];
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('legacy SQL row selection for deep and IS NOT NULL predicates', function () {
	this.timeout(120000);

	let T;
	let originalEngine;

	before(async () => {
		setupTestDBPath();
		setMainIsWorker(true);
		originalEngine = process.env.HARPER_SQL_ENGINE;
		mutation._setTransactionRunner(transaction);
		T = table({
			table: 'SqlLegacyRowSelection',
			database: 'test',
			attributes: [
				{ name: 'id', isPrimaryKey: true },
				{ name: 'grp', indexed: true },
				{ name: 'name' },
				{ name: 'v' },
				{ name: 'note' },
			],
		});
		await reseed();
	});

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

	const sorted = (ids) => [...ids].sort((a, b) => a - b);

	async function storedNotes() {
		const notes = {};
		for await (const record of T.search({ select: ['id', 'note'] })) notes[record.id] = record.note;
		return notes;
	}

	async function assertMatches(engine, where, expected) {
		await reseed();
		const rows = await sql(engine, `SELECT id FROM ${TABLE} WHERE ${where}`);
		assert.deepStrictEqual(sorted(rows.map((row) => row.id)), expected, `${engine} SELECT`);

		const update = await sql(engine, `UPDATE ${TABLE} SET note = 'hit' WHERE ${where}`);
		const notes = await storedNotes();
		assert.deepStrictEqual(sorted(update.update_hashes), expected, `${engine} UPDATE reported`);
		assert.deepStrictEqual(sorted(ALL_IDS.filter((id) => notes[id] === 'hit')), expected, `${engine} UPDATE stored`);

		await reseed();
		const removal = await sql(engine, `DELETE FROM ${TABLE} WHERE ${where}`);
		const survivors = await storedNotes();
		assert.deepStrictEqual(sorted(removal.deleted_hashes), expected, `${engine} DELETE reported`);
		assert.deepStrictEqual(sorted(ALL_IDS.filter((id) => !(id in survivors))), expected, `${engine} DELETE stored`);
	}

	for (const engine of ['legacy', 'auto']) {
		describe(engine, () => {
			it('IS NOT NULL matches every non-null value, falsy ones included', async () => {
				await assertMatches(engine, "grp = 'nullish' AND v IS NOT NULL", NOT_NULL);
				await assertMatches(engine, "grp = 'nullish' AND NOT v IS NULL", NOT_NULL);
			});

			it('IS NOT NULL in a statement auto hands to the legacy engine', async () => {
				await assertMatches(
					engine,
					"grp = 'nullish' AND v IS NOT NULL AND (CASE WHEN id > 0 THEN 1 ELSE 0 END) = 1",
					NOT_NULL
				);
			});

			it('an OR of 150 primary-key equalities matches all 150 keys', async () => {
				await assertMatches(
					engine,
					range(1, 150)
						.map((id) => `id = ${id}`)
						.join(' OR '),
					range(1, 150)
				);
			});

			it('an AND of 120 inequalities keeps every row they all allow', async () => {
				await assertMatches(
					engine,
					range(1001, 1120)
						.map((id) => `id <> ${id}`)
						.join(' AND '),
					ALL_IDS
				);
			});

			it('a predicate inside 120 parentheses or 240 NOTs still applies', async () => {
				await assertMatches(engine, `${'('.repeat(120)}id > 150${')'.repeat(120)}`, range(151, ROWS));
				await assertMatches(engine, `${'NOT '.repeat(240)}id > 150`, range(151, ROWS));
			});
		});
	}

	describe('legacy', () => {
		it('fetches a column nested in 120 function calls', async () => {
			const rows = await sql(
				'legacy',
				`SELECT ${'UPPER('.repeat(120)}name${')'.repeat(120)} AS u FROM ${TABLE} WHERE id = 1`
			);
			assert.deepStrictEqual(rows, [{ u: 'N1' }]);
		});

		it('rejects an unknown column nested inside 120 parentheses', async () => {
			await assert.rejects(
				sql('legacy', `SELECT id FROM ${TABLE} WHERE ${'('.repeat(120)}nosuch = 3${')'.repeat(120)}`),
				/unknown column nosuch/
			);
		});

		it('still refuses a SELECT, UPDATE or DELETE whose WHERE holds a subquery, and writes nothing', async () => {
			await reseed();
			for (const subquery of [
				`id IN (SELECT id FROM ${TABLE} WHERE id < 5)`,
				`EXISTS (SELECT id FROM ${TABLE} WHERE id < 5)`,
			]) {
				await assert.rejects(sql('legacy', `SELECT id FROM ${TABLE} WHERE ${subquery}`), /Circular reference/);
				await assert.rejects(sql('legacy', `UPDATE ${TABLE} SET note = 'hit' WHERE ${subquery}`), /Circular reference/);
				await assert.rejects(sql('legacy', `DELETE FROM ${TABLE} WHERE ${subquery}`), /Circular reference/);
			}
			const notes = await storedNotes();
			assert.deepStrictEqual(Object.keys(notes).length, ROWS);
			assert.ok(Object.values(notes).every((note) => note === 'seed'));
		});
	});
});
