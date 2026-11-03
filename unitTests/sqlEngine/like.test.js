'use strict';

const assert = require('assert');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const alasql = require('alasql');
const { compileExpr } = require('#src/sqlEngine/expressions/compile');
const { tokenizeLike } = require('#src/sqlEngine/expressions/like');
const { whereToConditions } = require('#src/sqlEngine/optimizer/whereToConditions');
const { normalizeStatement } = require('#src/sqlEngine/parser/normalizer');
const { EngineRuntimeError, EngineUnsupportedError } = require('#src/sqlEngine/errors');
const { ClientError } = require('#src/utility/errors/hdbError');
require('#src/sqlTranslator/alasqlFunctionImporter').default(alasql);

function likeExpr(pattern, escape, negated = false) {
	const expr = {
		kind: 'like',
		expr: { kind: 'column', name: 'v' },
		pattern: { kind: 'literal', value: pattern, sqlType: 'string' },
		negated,
	};
	if (escape !== undefined) expr.escape = escape;
	return expr;
}

function v2Like(pattern, value, escape) {
	return compileExpr(likeExpr(pattern, escape)).eval({ v: value });
}

// The v2 matcher before #1930: the parity oracle where it was not wrong.
function regexLike(pattern, value) {
	let r = '^';
	for (const ch of pattern) {
		if (ch === '%') r += '.*';
		else if (ch === '_') r += '.';
		else if (/[\\^$+?.()|{}[\]]/.test(ch)) r += '\\' + ch;
		else r += ch;
	}
	return new RegExp(r + '$').test(value);
}

function dpLike(pattern, value, escape) {
	const tokens = [];
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === escape) tokens.push({ literal: pattern[++i] });
		else if (ch === '%' || ch === '_') tokens.push(ch);
		else tokens.push({ literal: ch });
	}
	let row = [true];
	for (let j = 1; j <= value.length; j++) row.push(false);
	for (const token of tokens) {
		const next = [token === '%' && row[0]];
		for (let j = 1; j <= value.length; j++) {
			if (token === '%') next.push(next[j - 1] || row[j]);
			else if (token === '_') next.push(row[j - 1]);
			else next.push(row[j - 1] && value[j - 1] === token.literal);
		}
		row = next;
	}
	return row[value.length];
}

function randomString(next, alphabet, maxLength) {
	let text = '';
	const length = next() % (maxLength + 1);
	for (let i = 0; i < length; i++) text += alphabet[next() % alphabet.length];
	return text;
}

function seededRandom(seed) {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state >> 8;
	};
}

const PARITY_PATTERNS = [
	'',
	'%',
	'%%',
	'_',
	'__',
	'x',
	'%x',
	'x%',
	'%x%',
	'_x_',
	'x_',
	'_x',
	'a%c',
	'a_c',
	'%a%c%',
	'a%%c',
	'%a_c%',
	'ab%bc',
	'%a%a',
	'a.c',
	'a+c',
	'a?',
	'a(c)',
	'a[b]c',
	'a$c',
	'a^c',
	'a\\c',
	'a{2}',
	'a|b',
	'ABC',
	'abc',
	'%.%',
	'x%x',
	'x_x',
];
const PARITY_VALUES = [
	'',
	'a',
	'x',
	'xx',
	'ax',
	'xa',
	'axa',
	'xax',
	'abc',
	'ABC',
	'aac',
	'abbc',
	'abc_bc',
	'a.c',
	'abc.',
	'a+c',
	'a?',
	'a(c)',
	'a[b]c',
	'a$c',
	'a^c',
	'a\\c',
	'a{2}',
	'aa',
	'a|b',
	'x_x',
	'x%x',
	'xyzx',
];

describe('sqlEngine LIKE matcher (v2)', () => {
	it('matches exactly what the previous regex matcher matched for ordinary patterns', () => {
		for (const pattern of PARITY_PATTERNS) {
			for (const value of PARITY_VALUES) {
				assert.strictEqual(v2Like(pattern, value), regexLike(pattern, value), `${value} LIKE ${pattern}`);
			}
		}
	});

	it('agrees with a dynamic-programming reference on random patterns, with and without ESCAPE', () => {
		const next = seededRandom(1930);
		for (let i = 0; i < 4000; i++) {
			const escape = i % 2 ? '!' : undefined;
			let pattern = randomString(next, escape ? 'ab%_!' : 'ab%_', 7);
			if (escape && /(^|[^!])(!!)*!$/.test(pattern)) pattern += 'a';
			const value = randomString(next, 'ab%_!', 7);
			assert.strictEqual(v2Like(pattern, value, escape), dpLike(pattern, value, escape), `${value} LIKE ${pattern}`);
		}
	});

	it('honors ESCAPE for %, _, the escape itself, and an ordinary character', () => {
		assert.strictEqual(v2Like('t0!%', 't0%', '!'), true);
		assert.strictEqual(v2Like('t0!%', 't0!z', '!'), false);
		assert.strictEqual(v2Like('t0!%', 't0', '!'), false);
		assert.strictEqual(v2Like('t!_0', 't_0', '!'), true);
		assert.strictEqual(v2Like('t!_0', 'tx0', '!'), false);
		assert.strictEqual(v2Like('%!_%', 'a_b', '!'), true);
		assert.strictEqual(v2Like('%!_%', 'ab', '!'), false);
		assert.strictEqual(v2Like('a!!b', 'a!b', '!'), true);
		assert.strictEqual(v2Like('!a', 'a', '!'), true);
		assert.strictEqual(v2Like('100%%', '100%', '%'), true);
		assert.strictEqual(v2Like('100%%', '100abc', '%'), false);
	});

	it('keeps NULL three-valued and coerces non-string values as before', () => {
		assert.strictEqual(compileExpr(likeExpr('a%', undefined, true)).eval({ v: null }), null);
		assert.strictEqual(compileExpr(likeExpr('a%')).eval({}), null);
		assert.strictEqual(v2Like('12%', 12345), true);
		assert.strictEqual(compileExpr(likeExpr('12%', undefined, true)).eval({ v: 12345 }), false);
	});

	it('treats * as a literal and lets % match line terminators, as legacy does', () => {
		assert.strictEqual(v2Like('a*', 'a*'), true);
		assert.strictEqual(v2Like('a*', 'aaa'), false);
		assert.strictEqual(v2Like('a*', ''), false);
		assert.strictEqual(v2Like('a%b', 'a\nb'), true);
		assert.strictEqual(v2Like('a%b', 'a\u2028b'), true);
		assert.strictEqual(v2Like('a_b', 'a\nb'), false);
		assert.strictEqual(v2Like('a__b', 'a\r\nb'), false);
	});

	it('matches a segment of exactly 10,000 characters between wildcards', () => {
		const run = 'a'.repeat(9_998) + 'b_';
		assert.strictEqual(v2Like('%' + run + '%', 'x' + 'a'.repeat(9_999) + 'bzq'), true);
		assert.strictEqual(v2Like('%' + run + '%', 'x' + 'a'.repeat(9_999) + 'cz'), false);
		assert.strictEqual(v2Like(run + '%', 'a'.repeat(9_998) + 'bz'), true);
		assert.strictEqual(v2Like('_'.repeat(10_000), 'x'.repeat(10_000)), true);
		assert.strictEqual(v2Like('%' + 'a'.repeat(10_000) + '%', 'x' + 'a'.repeat(10_000)), true);
		assert.strictEqual(v2Like('!%'.repeat(10_000), '%'.repeat(10_000), '!'), true);
		assert.strictEqual(alasql.utils.like('%' + 'Ab'.repeat(5_000) + '%', 'x' + 'aB'.repeat(5_000)), true);
		assert.strictEqual(alasql.utils.like('%' + '[ab]'.repeat(10_000) + '%', 'x' + 'ab'.repeat(5_000)), true);
	});

	it('rejects a segment wider than 10,000 characters on both engines', () => {
		const tooWide = (error) => error instanceof ClientError && error.statusCode === 400 && /10000/.test(error.message);
		for (const pattern of [
			'%' + '_'.repeat(10_001) + 'c%',
			'%' + 'a'.repeat(10_000) + '_b%',
			'a'.repeat(10_001) + '%',
			'%' + 'a'.repeat(10_001),
			'_'.repeat(10_001),
			'%' + '!%'.repeat(10_001) + '%',
		]) {
			assert.throws(() => tokenizeLike(pattern, '!'), tooWide);
			assert.throws(() => v2Like(pattern, 'a', '!'), tooWide);
			assert.throws(() => alasql.utils.like(pattern, 'a', '!'), tooWide);
		}
		assert.throws(() => alasql.utils.like('%' + '[ab]'.repeat(10_001) + '%', 'a'), tooWide);
		assert.strictEqual(v2Like(('a'.repeat(10_000) + '%').repeat(3), 'a'.repeat(30_000)), true);
		assert.strictEqual(alasql.utils.like(('a'.repeat(10_000) + '%').repeat(3), 'a'.repeat(30_000)), true);
	});

	it('is case-sensitive', () => {
		assert.strictEqual(v2Like('abc', 'ABC'), false);
		assert.strictEqual(v2Like('%B%', 'abc'), false);
	});

	it('re-tokenizes a column-valued pattern only when it changes', () => {
		const like = compileExpr({
			kind: 'like',
			expr: { kind: 'column', name: 'v' },
			pattern: { kind: 'column', name: 'p' },
			escape: '!',
			negated: false,
		});
		assert.strictEqual(like.eval({ v: 't0%', p: 't0!%' }), true);
		assert.strictEqual(like.eval({ v: 't0!z', p: 't0!%' }), false);
		assert.strictEqual(like.eval({ v: 't0!z', p: 't0%' }), true);
		assert.strictEqual(like.eval({ v: 't0!z', p: null }), null);
		assert.throws(() => like.eval({ v: 'x', p: 'x!' }), EngineRuntimeError);
	});
});

describe('sqlEngine LIKE index conditions', () => {
	const ATTRS = [{ name: 'v', indexed: true }];
	const condition = (pattern, escape) => whereToConditions(likeExpr(pattern, escape), ATTRS).conditions[0];

	it('maps unescaped shapes exactly as before', () => {
		assert.deepStrictEqual(condition('ab%'), { attribute: 'v', comparator: 'starts_with', value: 'ab' });
		assert.deepStrictEqual(condition('%ab'), { attribute: 'v', comparator: 'ends_with', value: 'ab' });
		assert.deepStrictEqual(condition('%ab%'), { attribute: 'v', comparator: 'contains', value: 'ab' });
		assert.deepStrictEqual(condition('ab'), { attribute: 'v', comparator: 'equals', value: 'ab' });
		assert.deepStrictEqual(condition('%'), { attribute: 'v', comparator: 'contains', value: '' });
		assert.deepStrictEqual(condition('%%'), { attribute: 'v', comparator: 'contains', value: '' });
		for (const pattern of ['a_b%', '%a%b', 'a%b', '%%a', '_'])
			assert.strictEqual(condition(pattern), undefined, pattern);
	});

	it('builds the index condition from the unescaped literal', () => {
		assert.deepStrictEqual(condition('t0!%', '!'), { attribute: 'v', comparator: 'equals', value: 't0%' });
		assert.deepStrictEqual(condition('t0!%%', '!'), { attribute: 'v', comparator: 'starts_with', value: 't0%' });
		assert.deepStrictEqual(condition('%!_x', '!'), { attribute: 'v', comparator: 'ends_with', value: '_x' });
		assert.deepStrictEqual(condition('%a!!b%', '!'), { attribute: 'v', comparator: 'contains', value: 'a!b' });
		assert.deepStrictEqual(condition('100%%', '%'), { attribute: 'v', comparator: 'equals', value: '100%' });
		assert.strictEqual(condition('t!_%_', '!'), undefined);
	});
});

describe('sqlEngine LIKE ESCAPE normalization', () => {
	const where = (sql) => normalizeStatement(alasql.parse(sql).statements[0], 'select').where;

	it('carries the ESCAPE character into the IR', () => {
		const like = where("SELECT id FROM dev.t WHERE ip LIKE 't0!%' ESCAPE '!'");
		assert.strictEqual(like.kind, 'like');
		assert.strictEqual(like.escape, '!');
		assert.strictEqual(where("SELECT id FROM dev.t WHERE ip NOT LIKE 't0!%' ESCAPE '!'").escape, '!');
		assert.strictEqual(where("SELECT id FROM dev.t WHERE ip LIKE 't0%'").escape, undefined);
	});

	it('rejects an ESCAPE that is not one character, and a pattern ending in the escape, without fallback', () => {
		for (const sql of [
			"SELECT id FROM dev.t WHERE ip LIKE 't0!%' ESCAPE '!!'",
			"SELECT id FROM dev.t WHERE ip LIKE 't0%' ESCAPE ''",
			"SELECT id FROM dev.t WHERE ip LIKE 't0!' ESCAPE '!'",
			"SELECT id FROM dev.t WHERE ip NOT LIKE 't0!' ESCAPE '!'",
		]) {
			assert.throws(
				() => where(sql),
				(error) => error instanceof EngineRuntimeError && error.statusCode === 400,
				sql
			);
		}
		assert.throws(() => where("SELECT id FROM dev.t WHERE ip LIKE 't0!%' ESCAPE ip"), EngineUnsupportedError);
	});
});

describe('legacy alasql LIKE', () => {
	const rows = ['t_0', 'tx0', 't!x0', 't!_0', 't0%', 't0!z', 't0a', 'T0%'].map((c) => ({ c }));
	const select = (where) => alasql(`SELECT c FROM ? WHERE ${where}`, [rows]).map((row) => row.c);

	it('keeps ESCAPE when a WHERE clause is serialized and re-parsed', () => {
		const sql = "SELECT id FROM t WHERE c LIKE 't0!%' ESCAPE '!' AND d NOT LIKE 'x#_' ESCAPE '#'";
		const text = alasql.parse(sql).statements[0].where.toString();
		assert.strictEqual(text, "c LIKE 't0!%' ESCAPE '!' AND d NOT LIKE 'x#_' ESCAPE '#'");
		assert.strictEqual(alasql.parse(`SELECT id FROM t WHERE ${text}`).statements[0].where.toString(), text);
	});

	it('keeps alasql semantics: case-insensitive, ESCAPE, classes, and _ excluding line terminators', () => {
		assert.deepStrictEqual(select("c LIKE 't0!%' ESCAPE '!'"), ['t0%', 'T0%']);
		assert.deepStrictEqual(select("c LIKE 't0%'"), ['t0%', 't0!z', 't0a', 'T0%']);
		assert.deepStrictEqual(select("c LIKE 't[!_]%'"), ['t_0', 't!x0', 't!_0']);
		assert.deepStrictEqual(select("c LIKE 't[^!_]%'"), ['tx0', 't0%', 't0!z', 't0a', 'T0%']);
		assert.deepStrictEqual(select("c LIKE '[s-u]0_'"), ['t0%', 't0a', 'T0%']);
		assert.strictEqual(alasql.utils.like('a_b', 'a\nb'), false);
		assert.strictEqual(alasql.utils.like('a%b', 'a\nb'), true);
		assert.strictEqual(alasql.utils.like('ABC', 'abc'), true);
		assert.strictEqual(alasql.utils.like('é', 'É'), true);
		assert.strictEqual(alasql.utils.like('s', 'ſ'), false);
		assert.strictEqual(alasql.utils.like('a%', null), false);
		assert.strictEqual(alasql.utils.like('12%', 12345), true);
	});

	it('treats characters alasql leaked into its regex as literals', () => {
		assert.strictEqual(alasql.utils.like('a$b', 'a$b'), true);
		assert.strictEqual(alasql.utils.like('^a', 'a'), false);
		assert.strictEqual(alasql.utils.like('a\\d', 'a\\d'), true);
		assert.strictEqual(alasql.utils.like('a!d', 'ad', '!'), true);
		assert.strictEqual(alasql.utils.like('a!d', 'a5', '!'), false);
		assert.strictEqual(alasql.utils.like('a[b', 'a[b'), true);
	});

	it('honors an escaped ] inside a class', () => {
		assert.strictEqual(alasql.utils.like('a[!]]', 'a]', '!'), true);
		assert.strictEqual(alasql.utils.like('a[!]]', 'a!]', '!'), false);
		assert.strictEqual(alasql.utils.like('[a!-c]', 'b', '!'), false);
		assert.strictEqual(alasql.utils.like('[a!-c]', '-', '!'), true);
		assert.strictEqual(alasql.utils.like('[^_]', 'a', '^'), true);
		assert.strictEqual(alasql.utils.like('[^_]', '_', '^'), false);
		assert.strictEqual(alasql.utils.like('[^^]]', 'a', '^'), true);
		assert.strictEqual(alasql.utils.like('[^^]]', ']', '^'), false);
	});

	it('folds case per code unit in every segment position', () => {
		assert.strictEqual(alasql.utils.like('%AbC%', 'xxabcxx'), true);
		assert.strictEqual(alasql.utils.like('%a.c%', 'xxA.Cxx'), true);
		assert.strictEqual(alasql.utils.like('%a.c%', 'xxabcxx'), false);
		assert.strictEqual(alasql.utils.like('%s%', 'x\u017fx'), false);
		assert.strictEqual(alasql.utils.like('%\u00e9%', 'x\u00c9x'), true);
		assert.strictEqual(alasql.utils.like('%[a-c]b%', 'xxBBxx'), true);
		assert.strictEqual(alasql.utils.like('%ab%ab', 'ab'), false);
	});

	it('rejects a malformed pattern or escape with a client error', () => {
		const clientError = (error) => error instanceof ClientError && error.statusCode === 400;
		assert.throws(() => alasql.utils.like('[z-a]', 'b'), clientError);
		assert.throws(() => alasql.utils.like('a!', 'a', '!'), clientError);
		assert.throws(() => alasql.utils.like('a!%', 'a%', '!!'), clientError);
		assert.throws(() => alasql.utils.like('a%', 'a', ''), clientError);
		assert.throws(() => alasql.utils.like('a%', 'a', 1), clientError);
		assert.strictEqual(alasql.utils.like('a%', 'a'), true);
	});

	it('tokenizes unclosed [ in linear time', () => {
		assert.strictEqual(alasql.utils.like('['.repeat(10_000) + '%', '['.repeat(10_001)), true);
		// Linear: ~60 ms. Rescanning for `]` at every `[` (quadratic): ~50 s.
		const start = performance.now();
		assert.strictEqual(alasql.utils.like(('['.repeat(5_000) + '%').repeat(40), 'x'), false);
		assert.ok(performance.now() - start < 10_000);
	});
});

describe('LIKE cost is linear in the value (#1930)', function () {
	const fixture = join(__dirname, 'fixtures', 'likeTiming.js');
	const CASES = [
		['%_%_%_%_%_%_%_%_%_%_%_%_%_%_Z', 'a', 10_000],
		['%a%a%a%a%a%a%a%a%a%a%a%a%a%aZ', 'a', 10_000],
		['%' + 'a'.repeat(200) + '_b%', 'a', 10_000],
		['%' + '_'.repeat(9_999) + 'c%', 'a', 100_000],
		['%' + 'a'.repeat(9_998) + '_b%', 'a', 100_000],
	];

	for (const engine of ['v2', 'legacy']) {
		for (const [pattern, valueChar, valueLength] of CASES) {
			const shown = pattern.length > 40 ? pattern.slice(0, 40) + '…' : pattern;
			it(`${engine}: ${shown} against ${valueLength.toLocaleString('en-US')} characters`, () => {
				const args = [...process.execArgv, fixture, engine, pattern, valueChar, String(valueLength)];
				const child = spawnSync(process.execPath, args, {
					encoding: 'utf8',
					timeout: 20_000,
				});
				assert.strictEqual(child.signal, null, `matcher did not finish within 20 s (${engine})`);
				assert.strictEqual(child.status, 0, child.stderr);
				const { result, ms } = JSON.parse(child.stdout);
				assert.strictEqual(result, false);
				assert.ok(ms < 200, `${engine} took ${ms.toFixed(1)} ms`);
			});
		}
	}
});
