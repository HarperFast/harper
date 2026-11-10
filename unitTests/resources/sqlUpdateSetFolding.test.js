require('../testUtils');
const assert = require('node:assert');
const { setupTestDBPath } = require('../testUtils');
const { table } = require('#src/resources/databases');
const { setMainIsWorker } = require('#src/server/threads/manageThreads');
const { evaluateSQL } = require('#src/sqlTranslator/index');
const { runWithOperationAuthorizationBypass } = require('#src/server/serverHelpers/operationAuthorizationState');

const CONCURRENT = 20;

describe('SQL UPDATE SET evaluation on the v2 engine', function () {
	this.timeout(60000);

	let Untyped, Typed, originalEngine;

	before(() => {
		originalEngine = process.env.HARPER_SQL_ENGINE;
		setupTestDBPath();
		setMainIsWorker(true);
		Untyped = table({
			table: 'SqlSetFoldUntyped',
			database: 'test',
			attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'qty' }, { name: 'amt' }, { name: 'a' }, { name: 'b' }],
		});
		Typed = table({
			table: 'SqlSetFoldTyped',
			database: 'test',
			schemaDefined: true,
			attributes: [
				{ name: 'id', isPrimaryKey: true, type: 'Int' },
				{ name: 'qty', type: 'Int' },
				{ name: 'name', type: 'String' },
				{ name: 'big', type: 'BigInt' },
				{ name: 'ratio', type: 'Float' },
				{ name: 'at', type: 'Date' },
			],
		});
	});

	after(() => {
		if (originalEngine === undefined) delete process.env.HARPER_SQL_ENGINE;
		else process.env.HARPER_SQL_ENGINE = originalEngine;
	});

	// `new` rejects instead of falling back, so a result here is always the v2 executor's.
	function sql(statement, engine = 'new') {
		process.env.HARPER_SQL_ENGINE = engine;
		return runWithOperationAuthorizationBypass(
			true,
			() =>
				new Promise((resolve, reject) =>
					evaluateSQL({ sql: statement, hdb_user: { username: 'test' } }, (error, result) =>
						error ? reject(error) : resolve(result)
					)
				)
		);
	}

	async function seed(Table, record) {
		await Table.delete(record.id);
		await Table.put(record);
	}

	async function updated(Table, record, set) {
		await seed(Table, record);
		await sql(`UPDATE test.${Table.tableName} SET ${set} WHERE id = ${record.id}`);
		return { ...(await Table.get(record.id)) };
	}

	async function concurrently(Table, record, set) {
		await seed(Table, record);
		await Promise.all(
			Array.from({ length: CONCURRENT }, () => sql(`UPDATE test.${Table.tableName} SET ${set} WHERE id = ${record.id}`))
		);
		return (await Table.get(record.id)).qty;
	}

	describe('repeated assignments to one column fold in order', () => {
		it('adds every increment', async () => {
			assert.strictEqual((await updated(Untyped, { id: 1, qty: 10 }, 'qty = qty + 2, qty = qty + 3')).qty, 15);
			assert.strictEqual((await updated(Typed, { id: 1, qty: 10 }, 'qty = qty + 2, qty = qty + 3')).qty, 15);
		});

		it('applies an increment to the value an earlier assignment set', async () => {
			assert.strictEqual((await updated(Untyped, { id: 1, qty: 10 }, 'qty = 20, qty = qty + 5')).qty, 25);
		});

		it('keeps a later absolute assignment', async () => {
			assert.strictEqual((await updated(Untyped, { id: 1, qty: 10 }, 'qty = qty + 5, qty = 20')).qty, 20);
		});

		it('shows the folded value only to the same column', async () => {
			const row = await updated(Untyped, { id: 1, a: 10 }, 'a = a * 2, b = a, a = a + 3');
			assert.strictEqual(row.a, 23);
			assert.strictEqual(row.b, 10);
		});

		it('stays atomic under concurrent statements', async () => {
			assert.strictEqual(
				await concurrently(Untyped, { id: 1, qty: 0 }, 'qty = qty + 1, qty = qty + 1'),
				2 * CONCURRENT
			);
		});

		it('writes the evaluated value where the summed increment is not a valid operand for the type', async () => {
			const row = await updated(
				Typed,
				{ id: 1, qty: -2147483648, ratio: 0 },
				'qty = qty + 1073741824, qty = qty + 1073741824, ratio = ratio + 1e308, ratio = ratio + 1e308'
			);
			assert.strictEqual(row.qty, 0);
			assert.strictEqual(row.ratio, Infinity);
		});

		it('stays atomic at the edge of the operand range', async () => {
			const Long = table({
				table: 'SqlSetFoldLong',
				database: 'test',
				schemaDefined: true,
				attributes: [
					{ name: 'id', isPrimaryKey: true, type: 'Int' },
					{ name: 'qty', type: 'Long' },
				],
			});
			const edge = 9007199254740992;
			await seed(Long, { id: 1, qty: -edge });
			await Promise.all([1, 2].map(() => sql(`UPDATE test.SqlSetFoldLong SET qty = qty + ${edge} WHERE id = 1`)));
			assert.strictEqual((await Long.get(1)).qty, edge);
		});

		it('evaluates step by step where a summed increment would round differently', async () => {
			const boundary = 2 ** 53;
			assert.strictEqual(
				(await updated(Untyped, { id: 1, qty: boundary }, 'qty = qty + 1, qty = qty + 1')).qty,
				boundary
			);
			assert.strictEqual(
				(await updated(Untyped, { id: 1, qty: 1e16 }, 'qty = qty - 10000000000000000, qty = qty + 1')).qty,
				1
			);
		});
	});

	describe('right-hand sides read the pre-update row', () => {
		it('reads the old value of a column another assignment changes', async () => {
			for (const set of ['qty = qty + 5, amt = qty * 2', 'amt = qty * 2, qty = qty + 5']) {
				const row = await updated(Untyped, { id: 1, qty: 10 }, set);
				assert.strictEqual(row.qty, 15, set);
				assert.strictEqual(row.amt, 20, set);
			}
		});

		it('swaps two columns', async () => {
			const row = await updated(Untyped, { id: 1, a: 1, b: 2 }, 'a = b, b = a');
			assert.strictEqual(row.a, 2);
			assert.strictEqual(row.b, 1);
		});

		it('gives one expression one value whether or not it is an increment', async () => {
			for (const qty of [undefined, null]) {
				const row = await updated(Untyped, { id: 1, qty }, 'qty = qty + 5, amt = qty + 5');
				assert.strictEqual(row.qty, null, `qty ${qty}`);
				assert.strictEqual(row.amt, null, `qty ${qty}`);
			}
			const row = await updated(Untyped, { id: 1, qty: 'abc' }, 'qty = qty + 5, amt = qty + 5');
			assert(Number.isNaN(row.qty));
			assert(Number.isNaN(row.amt));
			assert.strictEqual((await updated(Typed, { id: 1, qty: null }, 'qty = qty + 5')).qty, null);
		});
	});

	describe('a qualified or grouped increment', () => {
		it('is an atomic increment', async () => {
			assert.strictEqual(await concurrently(Untyped, { id: 1, qty: 0 }, 'qty = SqlSetFoldUntyped.qty + 1'), CONCURRENT);
			for (const set of ['qty = 1 + 2 + qty', 'qty = qty + (1 + 2)', 'qty = qty - (1 - 4)']) {
				assert.strictEqual(await concurrently(Untyped, { id: 1, qty: 0 }, set), 3 * CONCURRENT, set);
			}
		});
	});

	describe('an increment of a value that is not a number', () => {
		it('writes what the expression evaluates to', async () => {
			assert(Number.isNaN((await updated(Untyped, { id: 1, qty: 'abc' }, 'qty = qty + 5')).qty));
			await sql('UPDATE test.SqlSetFoldUntyped SET qty = qty + 5 WHERE id = 1');
			assert(Number.isNaN((await Untyped.get(1)).qty), 'NaN stays NaN');
			assert.strictEqual((await updated(Untyped, { id: 1, qty: true }, 'qty = qty + 5')).qty, 6);
			assert.strictEqual((await updated(Untyped, { id: 1, qty: '' }, 'qty = qty + 5')).qty, 5);
			assert.strictEqual((await updated(Untyped, { id: 1, qty: '7' }, 'qty = qty + 5')).qty, 12);
		});

		it('stays atomic for a numeric string or a Date', async () => {
			assert.strictEqual(await concurrently(Untyped, { id: 1, qty: '0' }, 'qty = qty + 1'), CONCURRENT);
			assert.strictEqual(await concurrently(Untyped, { id: 1, qty: new Date(0) }, 'qty = qty + 1'), CONCURRENT);
		});

		it('does not apply an add operation to a String attribute', async () => {
			assert.strictEqual((await updated(Typed, { id: 1, name: null }, 'name = name + 5')).name, null);
			await seed(Typed, { id: 1, name: 'abc' });
			await assert.rejects(sql('UPDATE test.SqlSetFoldTyped SET name = name + 5 WHERE id = 1'), (error) => {
				assert.strictEqual(error.statusCode, 400);
				assert.match(error.message, /in property name must be a string/);
				return true;
			});
			assert.strictEqual((await Typed.get(1)).name, 'abc');
		});

		it('moves a Date by the evaluated milliseconds', async () => {
			assert.strictEqual((await updated(Typed, { id: 1, at: new Date(0) }, 'at = at + 5000')).at.getTime(), 5000);
		});

		it('keeps the exact add for a bigint', async () => {
			assert.strictEqual((await updated(Typed, { id: 1, big: 10n }, 'big = big + 5, big = big + 1')).big, 16n);
			assert.strictEqual(
				(await updated(Typed, { id: 1, big: 10n }, 'big = big + 10000000000000000, big = big + 1')).big,
				10000000000000011n
			);
		});

		it('leaves a value with no numeric conversion unchanged', async () => {
			const qty = { valueOf: null, toString: null };
			assert.deepStrictEqual({ ...(await updated(Untyped, { id: 1, qty }, 'qty = qty')).qty }, qty);
		});
	});

	it('does not misread other arithmetic on the column as an increment', async () => {
		assert.strictEqual((await updated(Untyped, { id: 1, qty: 10 }, 'qty = 10 - qty')).qty, 0);
		assert.strictEqual((await updated(Untyped, { id: 1, qty: 10 }, 'qty = (qty + 1) + (qty + 2)')).qty, 23);
	});

	it('rolls back every row when a later row fails validation', async () => {
		await seed(Typed, { id: 1, qty: 10, name: null });
		await seed(Typed, { id: 2, qty: 10, name: 'abc' });
		await assert.rejects(
			sql('UPDATE test.SqlSetFoldTyped SET qty = qty + 1, name = name + 5 WHERE id >= 1'),
			(error) => {
				return error.statusCode === 400;
			}
		);
		assert.strictEqual((await Typed.get(1)).qty, 10);
		assert.strictEqual((await Typed.get(2)).qty, 10);
		await Typed.delete(2);
	});

	it('folds under the default auto engine', async () => {
		await seed(Untyped, { id: 1, qty: 10 });
		await sql('UPDATE test.SqlSetFoldUntyped SET qty = qty + 2, qty = qty + 3 WHERE id = 1', 'auto');
		assert.strictEqual((await Untyped.get(1)).qty, 15);
	});
});
