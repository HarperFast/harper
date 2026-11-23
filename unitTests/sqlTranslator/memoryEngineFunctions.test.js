'use strict';
/**
 * The legacy SQL function library reproduces AlaSQL 4.22's results; these pin the semantics users can observe.
 * Expected values were taken from AlaSQL 4.22 with Harper's functions registered.
 */

const assert = require('node:assert');
const {
	AGGREGATES,
	Recordset,
	legacyLike,
	cloneDeep,
	compileConvert,
	compileFunctionCall,
	deepEqual,
	extend,
	flatArray,
	getValueOf,
	glob,
	isInlineFunction,
	nanToUndefined,
	regexpLike,
	undefinedOrValue,
} = require('#src/sqlTranslator/memoryEngine/functions');

const constant = (value) => () => value;
const call = (funcid, ...values) => compileFunctionCall(funcid, values.map(constant))({});
const construct = (funcid, ...values) => compileFunctionCall(funcid, values.map(constant), true)({});
const cast = (node, value) => compileConvert(node, constant(value))({});

/** Drives a named aggregate the way the group pipeline does: stage 1, stage 2 per later row, stage 3. */
function aggregate(name, values, extra = []) {
	const fn = AGGREGATES[name];
	let accumulator;
	values.forEach((value, i) => {
		accumulator = i === 0 ? fn(value, undefined, 1, ...extra) : fn(value, accumulator, 2, ...extra);
	});
	return fn(undefined, accumulator, 3);
}

describe('legacy SQL function library', function () {
	describe('dispatch', function () {
		it('prefers a function registered under the exact name, then inline, then called functions', function () {
			// DATE_ADD is Harper's (moment, returns ms); Date_Add misses that name and reaches the built-in.
			assert.strictEqual(call('DATE_ADD', '2024-01-15T00:00:00Z', 1, 'day'), Date.UTC(2024, 0, 16));
			const builtIn = call('Date_Add', '2024-01-15T00:00:00Z', 1000);
			assert.ok(builtIn instanceof Date);
			assert.strictEqual(builtIn.getTime(), Date.UTC(2024, 0, 15) + 1000);
			assert.strictEqual(typeof call('NOW'), 'number');
			assert.match(call('Now'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
			assert.strictEqual(call('upper', 'ab'), 'AB');
		});

		it('reports which calls are inlined', function () {
			assert.strictEqual(isInlineFunction('upper'), true);
			assert.strictEqual(isInlineFunction('iif'), true);
			assert.strictEqual(isInlineFunction('ROUND'), false);
			assert.strictEqual(isInlineFunction('DATE'), false);
			assert.strictEqual(isInlineFunction('toString'), false);
		});

		it('fails an unknown function only when evaluated, after evaluating its arguments', function () {
			let evaluated = 0;
			const evaluator = compileFunctionCall('NO_SUCH_FUNCTION', [() => evaluated++]);
			assert.strictEqual(evaluated, 0);
			assert.throws(() => evaluator({}), TypeError);
			assert.strictEqual(evaluated, 1);
		});

		it('treats names AlaSQL kept for itself, and Object.prototype keys, as unknown', function () {
			for (const name of ['__ala__', 'OBJECT_ID', 'toString', 'valueOf', 'constructor', 'hasOwnProperty']) {
				assert.throws(() => call(name, 'x'), TypeError, name);
			}
		});

		it('checks IIF arity at compile time and evaluates only the chosen branch', function () {
			assert.throws(() => compileFunctionCall('IIF', [constant(1), constant(2)]), /Number of arguments of IFF/);
			const branch = (value) => () => {
				throw new Error(`evaluated ${value}`);
			};
			assert.strictEqual(compileFunctionCall('IIF', [constant(0), branch('then'), constant('no')])({}), 'no');
		});

		it('constructs with NEW, except for inlined functions', function () {
			assert.strictEqual(construct('Date', 0).getTime(), 0);
			assert.strictEqual(typeof construct('CONCAT', 'a'), 'object');
			assert.throws(() => construct('CHAR', 65), TypeError);
			assert.strictEqual(construct('UPPER', 'ab'), 'AB');
		});
	});

	describe('inlined functions', function () {
		it('pass undefined through but not NULL', function () {
			assert.strictEqual(call('UPPER', undefined), undefined);
			assert.strictEqual(call('UPPER', null), 'NULL');
			assert.strictEqual(call('LOWER', 5), '5');
			assert.strictEqual(call('LEN', undefined), undefined);
			assert.throws(() => call('LEN', null), TypeError);
			assert.throws(() => call('TRIM', null), TypeError);
			assert.throws(() => call('TRIM', 5), TypeError);
		});

		it('LEN reads .length', function () {
			assert.strictEqual(call('LEN', 'abc'), 3);
			assert.strictEqual(call('LENGTH', [1, 2]), 2);
			assert.strictEqual(call('LEN', 5), undefined);
		});

		it('trims spaces only', function () {
			assert.strictEqual(call('TRIM', ' a '), 'a');
			assert.strictEqual(call('LTRIM', '  a '), 'a ');
			assert.strictEqual(call('RTRIM', ' a  '), ' a');
			assert.strictEqual(call('LTRIM', '\ta'), '\ta');
		});

		it('SUBSTRING is 1-based substr with two or three arguments, else undefined', function () {
			assert.strictEqual(call('SUBSTRING', 'Hello', 2), 'ello');
			assert.strictEqual(call('SUBSTR', 'Hello', '2', 3), 'ell');
			assert.strictEqual(call('MID', 'Hello', 0, 2), 'o');
			assert.strictEqual(call('SUBSTRING', 'Hello'), undefined);
			assert.strictEqual(call('SUBSTRING', undefined, 1), undefined);
		});

		it('IFNULL replaces NULL and undefined; NULLIF and ISNULL compare loosely', function () {
			assert.strictEqual(call('IFNULL', null, 'd'), 'd');
			assert.strictEqual(call('IFNULL', undefined, 'd'), 'd');
			assert.strictEqual(call('IFNULL', 0, 'd'), 0);
			assert.ok(Number.isNaN(call('IFNULL', NaN, 'd')));
			assert.strictEqual(call('NULLIF', 1, '1'), undefined);
			assert.strictEqual(call('NULLIF', 0, ''), undefined);
			assert.strictEqual(call('NULLIF', null), undefined);
			assert.strictEqual(call('ISNULL', 1, 2), 1);
		});

		it('INSTR is indexOf + 1 on strings and arrays', function () {
			assert.strictEqual(call('INSTR', 'hello', 'l'), 3);
			assert.strictEqual(call('INSTR', 'hello', 'z'), 0);
			assert.strictEqual(call('INSTR', [1, 2], 2), 2);
			assert.throws(() => call('INSTR', 5, '5'), TypeError);
		});

		it('MAX and MIN of several arguments compare with > and <', function () {
			assert.strictEqual(call('MAX', 1, '2', 3), 3);
			assert.strictEqual(call('GREATEST', '10', '9'), '9');
			assert.strictEqual(call('MIN', null, 1), null);
			assert.throws(() => call('MAX'), TypeError);
		});

		it('math functions coerce with JavaScript Math', function () {
			assert.strictEqual(call('ABS', '-3'), 3);
			assert.ok(Number.isNaN(call('ABS')));
			assert.strictEqual(call('EXP', 1), Math.E);
			assert.strictEqual(call('CEIL', '1.2'), 2);
			assert.strictEqual(call('POWER', 2, '3'), 8);
			assert.ok(Number.isNaN(call('SQRT', -1)));
			assert.strictEqual(call('ROWNUM'), 1);
			const random = call('RANDOM', 10);
			assert.ok(Number.isInteger(random) && random >= 0 && random < 10);
		});

		it('CLONEDEEP copies', function () {
			const value = { a: [1, { b: 2 }] };
			const clone = call('CLONEDEEP', value);
			assert.deepStrictEqual(clone, value);
			assert.notStrictEqual(clone.a, value.a);
		});
	});

	describe('called functions', function () {
		it('CONCAT and CONCAT_WS', function () {
			assert.strictEqual(call('CONCAT', 'a', null, 1, undefined, [1, 2]), 'a11,2');
			assert.strictEqual(call('CONCAT_WS', ',', 'a', null, 'b'), 'a,b');
			// NULLs are dropped before the separator is taken.
			assert.strictEqual(call('CONCAT_WS', null, 'a', 'b', 'c'), 'bac');
		});

		it('REPLACE', function () {
			assert.strictEqual(call('REPLACE', 'aXbX', 'X', '-'), 'a-b-');
			assert.strictEqual(call('REPLACE', null, 'a', 'b'), '');
			assert.strictEqual(call('REPLACE', 'abc', '', 'z'), 'abc');
			assert.strictEqual(call('REPLACE', 'ab', null, '-'), 'a-b');
		});

		it('ROUND', function () {
			assert.strictEqual(call('ROUND', 2.5), 3);
			assert.strictEqual(call('ROUND', -2.5), -2);
			assert.strictEqual(call('ROUND', 1.005, 2), 1);
			assert.strictEqual(call('ROUND', '1.255', 2), 1.25);
			for (const blank of ['', ' ', 'x', null, undefined]) assert.strictEqual(call('ROUND', blank), undefined);
			assert.ok(Number.isNaN(call('ROUND', 1.25, undefined)));
			assert.strictEqual(call('ROUND', 1.25, null), 1);
		});

		it('COALESCE skips NULL, undefined and NaN', function () {
			assert.strictEqual(call('COALESCE', null, undefined, NaN, 0), 0);
			assert.strictEqual(call('COALESCE', NaN), undefined);
		});

		it('REGEXP_LIKE, ASCII, CHAR, USER', function () {
			assert.strictEqual(call('REGEXP_LIKE', 'Abc', '^a', 'i'), true);
			assert.strictEqual(call('REGEXP_LIKE', null, 'a'), false);
			assert.strictEqual(call('REGEXP_LIKE', 'a word', '[[:<:]]word[[:>:]]'), true);
			assert.strictEqual(call('ASCII', 'A'), 65);
			assert.strictEqual(call('CHAR', 72, 105), 'Hi');
			assert.strictEqual(call('USER'), 'alasql');
		});

		it('date parts read local time; dotted dates read as dashed', function () {
			const date = new Date(2024, 0, 15, 10, 20, 30);
			assert.strictEqual(call('YEAR', '2024.01.15 10:20:30'), 2024);
			assert.strictEqual(call('MONTH', date), 1);
			assert.strictEqual(call('DAY', date), 15);
			assert.strictEqual(call('WEEKDAY', date), 1);
			assert.strictEqual(call('HOUR', date), 10);
			assert.strictEqual(call('MINUTE', date), 20);
			assert.strictEqual(call('SECOND', date), 30);
			assert.strictEqual(call('dAtE', '20240115').getTime(), new Date(2024, 0, 15).getTime());
		});

		it('INTERVAL, DATEADD and TIMESTAMPDIFF', function () {
			assert.strictEqual(call('INTERVAL', 2, 'day'), 172800000);
			assert.strictEqual(
				call('DATEADD', 'dd', 1, '2024.01.15 10:20:30').getTime(),
				new Date(2024, 0, 16, 10, 20, 30).getTime()
			);
			assert.strictEqual(call('TIMESTAMPDIFF', 'day', '2024-01-01', '2024-01-11'), 10);
			assert.throws(() => call('TIMESTAMPDIFF', 'bogus', '2024-01-01', '2024-01-11'), /Unknown date part: bogus/);
		});

		it('NOW, CURDATE and UUID shapes', function () {
			assert.match(call('curdate'), /^\d{4}-\d{2}-\d{2}$/);
			assert.match(call('UUID'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		});

		it('EXTEND mutates its first argument', function () {
			const target = { a: 1 };
			assert.strictEqual(call('EXTEND', target, { b: 2 }), target);
			assert.deepStrictEqual(target, { a: 1, b: 2 });
		});
	});

	describe('CAST and CONVERT', function () {
		it('converts by type name', function () {
			assert.strictEqual(cast({ dbtypeid: 'INT' }, '12.7'), 12);
			assert.strictEqual(cast({ dbtypeid: 'MONEY' }, 1.5), 1.5);
			assert.strictEqual(cast({ dbtypeid: 'VARCHAR', dbsize: 3 }, 'abcdef'), 'abc');
			assert.strictEqual(cast({ dbtypeid: 'CHAR', dbsize: 8 }, 'abcdef'), 'abcdef  ');
			assert.strictEqual(cast({ dbtypeid: 'NUMBER', dbsize: 5, dbprecision: 2 }, '3.14159'), 3.14);
			assert.strictEqual(cast({ dbtypeid: 'BOOLEAN' }, ''), false);
			assert.deepStrictEqual(cast({ dbtypeid: 'json' }, '{"a":1}'), { a: 1 });
			assert.strictEqual(cast({ dbtypeid: 'JSON' }, null), null);
			assert.throws(() => cast({ dbtypeid: 'JSON' }, 'x'), /Cannot convert string to JSON/);
			const value = { a: 1 };
			assert.strictEqual(cast({ dbtypeid: 'TEXT' }, value), value);
		});

		it('formats dates and styles', function () {
			const date = new Date(2024, 0, 5);
			assert.strictEqual(cast({ dbtypeid: 'DATE' }, date), '24.01.05');
			assert.strictEqual(cast({ dbtypeid: 'DATETIME' }, date), '2024.01.05 00:00:00.000');
			assert.strictEqual(cast({ dbtypeid: 'VARCHAR', style: '101' }, date), '01/05/2024');
			assert.strictEqual(cast({ dbtypeid: 'VARCHAR', style: '112' }, date), '20240105');
			assert.throws(() => cast({ dbtypeid: 'VARCHAR', style: '9' }, date), /CONVERT style 9 is not realized/);
		});

		it('throws a ReferenceError at run time for a MAX size', function () {
			const evaluator = compileConvert({ dbtypeid: 'VARCHAR', dbsize: 'MAX' }, constant('x'));
			assert.throws(() => evaluator({}), ReferenceError);
		});
	});

	describe('utilities', function () {
		it('deepEqual, getValueOf, cloneDeep', function () {
			assert.strictEqual(deepEqual({ a: [1, 2] }, { a: [1, 2] }), true);
			assert.strictEqual(deepEqual(1, '1'), false);
			assert.strictEqual(deepEqual(NaN, NaN), false);
			assert.strictEqual(getValueOf(new Number(5)), 5);
			const clone = cloneDeep(JSON.parse('{"__proto__":{"x":1}}'));
			assert.ok(Object.hasOwn(clone, '__proto__'));
			assert.strictEqual(Object.getPrototypeOf(clone), Object.prototype);
			assert.deepStrictEqual(extend(null, { a: 1 }), { a: 1 });
		});

		it('glob is case-insensitive with * and ?', function () {
			assert.strictEqual(glob('Hello', 'h*'), true);
			assert.strictEqual(glob('abc', 'a?c'), true);
			assert.strictEqual(glob('abc', 'a.c'), false);
			assert.strictEqual(glob(null, ''), true);
			assert.strictEqual(regexpLike('xab', 'a'), true);
			assert.strictEqual(legacyLike('a%', 'abc'), true);
		});

		it('flatArray reads the first key, or a recordset first column', function () {
			assert.deepStrictEqual(flatArray([{ a: 1 }, { a: 2, b: 3 }, { b: 4 }]), [1, 2, undefined]);
			assert.deepStrictEqual(flatArray([]), []);
			assert.deepStrictEqual(flatArray(null), []);
			const recordset = new Recordset({ data: [{ x: new String('s') }, { x: 2 }], columns: [{ columnid: 'x' }] });
			assert.deepStrictEqual(flatArray(recordset), ['s', 2]);
		});

		it('nanToUndefined and undefinedOrValue', function () {
			assert.strictEqual(nanToUndefined(NaN), undefined);
			assert.strictEqual(nanToUndefined(0), 0);
			assert.strictEqual(
				undefinedOrValue(null, (value) => `${value}!`),
				'null!'
			);
			assert.strictEqual(
				undefinedOrValue(undefined, () => 'called'),
				undefined
			);
		});
	});

	describe('named aggregates', function () {
		it('GROUP_CONCAT skips NULL, orders and joins with the stage-1/2 extras', function () {
			assert.strictEqual(aggregate('GROUP_CONCAT', ['b', null, 'a']), 'b,a');
			assert.strictEqual(aggregate('GROUP_CONCAT', ['b', null, 'a'], ['|', 'DESC']), 'b|a');
			assert.strictEqual(aggregate('GROUP_CONCAT', [10, 9, 100], [undefined, 'ASC']), '9,10,100');
			assert.strictEqual(aggregate('GROUP_CONCAT', [null, null]), undefined);
		});

		it('AlaSQL built-ins finish an empty group with undefined, Harper aggregates with null', function () {
			for (const name of ['GROUP_CONCAT', 'QUART', 'VAR', 'STD']) {
				assert.strictEqual(AGGREGATES[name](undefined, undefined, 3), undefined, name);
			}
			for (const name of ['MEDIAN', 'MODE', 'MAD', 'MEAN', 'PROD', 'median']) {
				assert.strictEqual(AGGREGATES[name](undefined, undefined, 3), null, name);
			}
			assert.strictEqual(AGGREGATES.toString, undefined);
		});

		it('statistics', function () {
			assert.strictEqual(aggregate('MEDIAN', [1, 2, 3, 4]), 2.5);
			assert.strictEqual(aggregate('MEDIAN', [3, null, 1, 2]), 2);
			assert.deepStrictEqual(aggregate('MODE', ['x', 'y', 'x']), ['x']);
			assert.deepStrictEqual(aggregate('mode', [2, 2, 1, 1]), [2, 1]);
			assert.strictEqual(aggregate('MAD', [1, 2, 3, 4]), 1);
			assert.strictEqual(aggregate('MEAN', [1, 2, 3]), 2);
			assert.strictEqual(aggregate('PROD', [2, 3, 4]), 24);
			const eight = [4, 1, 3, 2, 5, 6, 7, 8];
			assert.strictEqual(aggregate('QUART', eight), 3);
			assert.strictEqual(aggregate('QUART2', eight), 5);
			assert.strictEqual(aggregate('QUART3', eight), 7);
			assert.strictEqual(aggregate('VAR', [1, 2, 3, 4]), 1.6666666666666667);
			assert.strictEqual(aggregate('STDEV', [1, 2, 3, 4]), 1.2909944487358056);
			assert.strictEqual(aggregate('VARP', [1, 2, 3, 4]), 1.25);
			assert.strictEqual(aggregate('STDDEV', [1, 2, 3, 4]), 1.118033988749895);
			assert.strictEqual(aggregate('VAR', [5]), 0);
		});

		it('VAR skips NULL but VARP counts it', function () {
			assert.strictEqual(aggregate('VAR', [1, null, 3]), 2);
			assert.strictEqual(aggregate('VARP', [2, null]), 1);
			assert.ok(Number.isNaN(aggregate('VAR', [2, undefined])));
		});
	});
});
