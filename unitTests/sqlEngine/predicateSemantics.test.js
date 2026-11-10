'use strict';

// harper#3208: truthiness, blank strings and ordering in compiled SQL v2 expressions

const assert = require('node:assert');
const { compileExpr, compilePredicate } = require('#src/sqlEngine/expressions/compile');

const v = { kind: 'column', name: 'v' };
const lit = (value) => ({ kind: 'literal', value, sqlType: 'unknown' });
const bin = (op, left, right) => ({ kind: 'binop', op, left, right });
const not = (arg) => ({ kind: 'logical', op: 'not', args: [arg] });
const between = (low, high, negated = false) => ({ kind: 'between', expr: v, low: lit(low), high: lit(high), negated });
const evaluate = (expr, value) => compileExpr(expr).eval({ v: value });
const show = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value));

describe('sqlEngine compiled predicate semantics', () => {
	describe('truthiness', () => {
		const FALSY = [0, -0, NaN, '', 0n, false, null, undefined];
		const TRUTHY = [1, -1, Infinity, '   ', '0', 'false', 'x', true, 1n, {}, [], new Date(0)];

		it('a bare value admits a row only when it is truthy', () => {
			const passes = compilePredicate(v);
			for (const value of FALSY) assert.strictEqual(passes({ v: value }), false, show(value));
			for (const value of TRUTHY) assert.strictEqual(passes({ v: value }), true, show(value));
		});

		it('NOT, AND, OR and CASE read the same truth value', () => {
			for (const value of [...FALSY, ...TRUTHY]) {
				const expected = Boolean(value);
				if (value != null) assert.strictEqual(evaluate(not(v), value), !expected, `NOT ${show(value)}`);
				const and = { kind: 'logical', op: 'and', args: [v, lit(true)] };
				const or = { kind: 'logical', op: 'or', args: [v, lit(false)] };
				const caseExpr = { kind: 'case', cases: [{ when: v, then: lit('yes') }], else: lit('no') };
				assert.strictEqual(compilePredicate(and)({ v: value }), expected, `AND ${show(value)}`);
				assert.strictEqual(compilePredicate(or)({ v: value }), expected, `OR ${show(value)}`);
				assert.strictEqual(evaluate(caseExpr, value), expected ? 'yes' : 'no', `CASE ${show(value)}`);
			}
		});
	});

	describe('a blank string has no numeric value', () => {
		const BLANKS = ['', ' ', '\t', '\n', '\r\n', ' ', ' ', '﻿'];
		const inList = (negated) => ({ kind: 'in', expr: v, list: [lit(0)], negated });

		for (const blank of BLANKS) {
			it(`${show(blank)} equals no number and makes arithmetic NaN`, () => {
				assert.strictEqual(evaluate(bin('=', v, lit(0)), blank), false);
				assert.strictEqual(evaluate(bin('=', lit(0), v), blank), false);
				assert.strictEqual(evaluate(bin('<>', v, lit(0)), blank), true);
				assert.strictEqual(evaluate(inList(false), blank), false);
				assert.strictEqual(evaluate(inList(true), blank), true);
				assert.ok(Number.isNaN(evaluate(bin('+', v, lit(1)), blank)));
				assert.ok(Number.isNaN(evaluate(bin('*', v, lit(1)), blank)));
			});
		}

		it('a padded or zero numeric string still reads as its number', () => {
			assert.strictEqual(evaluate(bin('=', v, lit(5)), ' 5 '), true);
			assert.strictEqual(evaluate(bin('=', v, lit(0)), '0'), true);
			assert.strictEqual(evaluate(bin('=', v, lit(0)), ' 0\n'), true);
			assert.strictEqual(evaluate(bin('+', v, lit(1)), '5'), 6);
		});
	});

	describe('ordering', () => {
		const CASES = [
			[NaN, '<', 1, null],
			[1, '>', NaN, null],
			[NaN, '>=', NaN, null],
			[NaN, '=', NaN, false],
			[NaN, '<>', 0, true],
			[Infinity, '<=', Infinity, true],
			[Infinity, '<', Infinity, false],
			[-Infinity, '<', Infinity, true],
			[-Infinity, '>=', -Infinity, true],
			['', '>', 0, true],
			['', '>=', 0, true],
			['', '<', 0, false],
			['', '<=', 0, false],
			['   ', '>', 5, true],
			['x', '>', 5, true],
			['-x', '>', 5, true],
			['-x', '<', 5, false],
			[0, '<', '', true],
			[true, '<', '', true],
			['', '<', 'b', true],
			['', '<', '0', true],
			['', '>', '', false],
			['', '>=', '', true],
			['5', '<', 10, true],
			['10', '>', 9, true],
			[new Date(5), '<', 10, true],
		];
		for (const [left, op, right, expected] of CASES) {
			it(`${show(left)} ${op} ${show(right)} is ${expected}`, () => {
				assert.strictEqual(compileExpr(bin(op, lit(left), lit(right))).eval({}), expected);
			});
		}

		it('a NaN made by arithmetic on a blank string has no order', () => {
			assert.strictEqual(evaluate(bin('>', bin('+', v, lit(0)), lit('0')), ''), null);
			assert.strictEqual(evaluate(bin('<', bin('+', v, lit(0)), lit('0')), '   '), null);
		});

		it('NOT of an unordered comparison stays NULL, as its normalized inverse is', () => {
			assert.strictEqual(evaluate(not(bin('<', v, lit(1))), NaN), null);
			assert.strictEqual(evaluate(bin('>=', v, lit(1)), NaN), null);
		});

		it('a bigint never throws', () => {
			assert.doesNotThrow(() => evaluate(bin('+', v, lit(0)), 0n));
			assert.doesNotThrow(() => evaluate(bin('<', v, lit(1)), 0n));
			assert.doesNotThrow(() => evaluate(between(0, 1), 0n));
		});
	});

	describe('BETWEEN is v >= low AND v <= high in three-valued logic', () => {
		const CASES = [
			[NaN, 0, 1, null],
			[5, 0, NaN, null],
			[5, 6, NaN, false],
			[5, NaN, 4, false],
			['', 0, 1, false],
			[Infinity, 0, Infinity, true],
			[0.5, 0, 1, true],
			[5, null, 1, false],
			[0.5, null, 1, null],
			[null, 0, 1, null],
		];
		for (const [value, low, high, expected] of CASES) {
			it(`${show(value)} BETWEEN ${show(low)} AND ${show(high)} is ${expected}, NOT BETWEEN its negation`, () => {
				assert.strictEqual(evaluate(between(low, high), value), expected);
				assert.strictEqual(evaluate(between(low, high, true), value), expected == null ? null : !expected);
			});
		}
	});
});
