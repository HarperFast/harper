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

// `_` matches any one code unit, line terminators included, as in both engines.
function dpLike(pattern, value, escape, caseInsensitive = false) {
	if (caseInsensitive) {
		pattern = pattern.toLowerCase();
		value = value.toLowerCase();
	}
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
	it('matches exactly what the previous regex matcher matched for ordinary patterns, on values without line terminators', () => {
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

	it('agrees with the reference on values and patterns holding line terminators, on both engines', () => {
		const next = seededRandom(3936);
		for (let i = 0; i < 6000; i++) {
			const escape = i % 3 === 0 ? '!' : undefined;
			let pattern = randomString(next, escape ? 'a%___\n!' : 'aA%___\n\r', 12);
			if (escape && /(^|[^!])(!!)*!$/.test(pattern)) pattern += 'a';
			const value = randomString(next, 'aaA\n\r\u2028_', 16);
			const label = `${JSON.stringify(value)} LIKE ${JSON.stringify(pattern)}`;
			assert.strictEqual(v2Like(pattern, value, escape), dpLike(pattern, value, escape), label);
			const legacy =
				escape === undefined ? alasql.utils.like(pattern, value) : alasql.utils.like(pattern, value, escape);
			assert.strictEqual(legacy, dpLike(pattern, value, escape, true), `legacy ${label}`);
		}
	});

	it('agrees with the reference on wide segments mixing _, line terminators, classes and noncharacters', () => {
		// [pattern text, legacy only, accepts]
		const PIECES = [
			['%', false, null],
			['_', false, () => true],
			['a', false, (c) => c === 'a'],
			['\n', false, (c) => c === '\n'],
			['\r', false, (c) => c === '\r'],
			['[^a]', true, (c) => c !== 'a'],
			['[a\n]', true, (c) => c === 'a' || c === '\n'],
			['[^\uffff]', true, (c) => c !== '\uffff'],
			['\uffff', false, (c) => c === '\uffff'],
			['\ufffe', false, (c) => c === '\ufffe'],
		];
		const reference = (pieces, value) => {
			let row = [true, ...Array(value.length).fill(false)];
			for (const [, , accepts] of pieces) {
				const next = [!accepts && row[0]];
				for (let j = 1; j <= value.length; j++) {
					next.push(accepts ? row[j - 1] && accepts(value[j - 1]) : next[j - 1] || row[j]);
				}
				row = next;
			}
			return row[value.length];
		};
		const next = seededRandom(2028);
		const ALPHABET = 'aaaaab\n\n\r\uffff\ufffe';
		const sample = (accepts) => {
			for (;;) {
				const char = ALPHABET[next() % ALPHABET.length];
				if (accepts(char)) return char;
			}
		};
		for (let i = 0; i < 3000; i++) {
			const legacy = i % 2 === 1;
			const pieces = [PIECES[0]];
			for (let n = 1 + (next() % 6); n > 0; n--) {
				const piece = PIECES[1 + (next() % (PIECES.length - 1))];
				if (piece[1] && !legacy) continue;
				const ones = next() % 2 ? next() % 8 : 60 + (next() % 20);
				for (let k = piece[0] === '_' ? ones : 1 + (next() % 3); k > 0; k--) pieces.push(piece);
			}
			pieces.push(PIECES[0]);
			if (next() % 3 === 0) pieces.splice(1 + (next() % (pieces.length - 2)), 0, PIECES[0]);
			const pattern = pieces.map(([text]) => text).join('');
			// Mostly a match with up to two characters changed, so the search moves past near misses.
			let value = randomString(next, ALPHABET, 20);
			for (const [, , accepts] of pieces) value += accepts ? sample(accepts) : randomString(next, ALPHABET, 6);
			for (let n = i % 4 === 0 ? 0 : next() % 3; n > 0; n--) {
				const at = next() % value.length;
				value = value.slice(0, at) + ALPHABET[next() % ALPHABET.length] + value.slice(at + 1);
			}
			const label = `${JSON.stringify(value)} LIKE ${JSON.stringify(pattern)}`;
			const actual = legacy ? alasql.utils.like(pattern, value) : v2Like(pattern, value);
			assert.strictEqual(actual, reference(pieces, value), (legacy ? 'legacy ' : 'v2 ') + label);
		}
	});

	it('matches any one code unit with _, in every segment position, on both engines', () => {
		for (const like of [v2Like, (pattern, value) => alasql.utils.like(pattern, value)]) {
			for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
				assert.strictEqual(like('a_b', `a${terminator}b`), true);
				assert.strictEqual(like('_%', terminator), true);
				assert.strictEqual(like('%_', terminator), true);
				assert.strictEqual(like('%_%', terminator), true);
			}
			assert.strictEqual(like('a_b', 'a\r\nb'), false);
			assert.strictEqual(like('a__b', 'a\r\nb'), true);
			assert.strictEqual(like('a_b', 'a\ud83d\ude00b'), false);
			assert.strictEqual(like('a__b', 'a\ud83d\ude00b'), true);
			assert.strictEqual(like('a_b', 'a\ud83db'), true);
			assert.strictEqual(like('___', 'ab'), false);
			assert.strictEqual(like('___', 'a\nb'), true);
			assert.strictEqual(like('%__%__', 'abc'), false);
			assert.strictEqual(like('%__%__', 'abcd'), true);
			assert.strictEqual(like('%__%a', 'aa'), false);
			assert.strictEqual(like('__%__%__', 'abcde'), false);
			assert.strictEqual(like('__%__%__', 'abcdef'), true);
			const run = '_'.repeat(70);
			assert.strictEqual(like('%a%' + run + '%b', 'xa' + '\n'.repeat(70) + 'b'), true);
			assert.strictEqual(like('%a%' + run + '%b', 'xa' + '\n'.repeat(69) + 'b'), false);
			assert.strictEqual(like('%\n' + run + '\n%', 'a\n' + 'b\n'.repeat(35) + '\n'), true);
			assert.strictEqual(like('%\n' + run + '\n%', 'a\n' + 'b\n'.repeat(35) + 'c'), false);
		}
		assert.strictEqual(v2Like('a!_b', 'a\nb', '!'), false);
		assert.strictEqual(alasql.utils.like('a!_b', 'a\nb', '!'), false);
	});

	it('keeps line terminators and noncharacters in the value distinct from those in the pattern', () => {
		const run = '_'.repeat(70);
		const a = 'a'.repeat(70);
		assert.strictEqual(v2Like('%' + run + '\n%', a + '\r'), false);
		assert.strictEqual(v2Like('%' + run + '\n%', a + '\n'), true);
		assert.strictEqual(v2Like('%\n' + run + '%', '\uffff' + a), false);
		assert.strictEqual(alasql.utils.like('%[^\uffff]' + run + '%', '\uffff' + a), false);
		assert.strictEqual(alasql.utils.like('%[^\uffff]' + run + '%', '\n' + a), true);
		assert.strictEqual(alasql.utils.like('%[b\n]' + run + '%', '\r' + a), false);
		// Past 64 `_`, legacy matches `_` against a placeholder noncharacter, which the value may hold.
		for (const like of [v2Like, (pattern, value) => alasql.utils.like(pattern, value)]) {
			assert.strictEqual(like('%a' + run + '%', 'a' + '\uffff'.repeat(70)), true);
			// The match starts in the first search window and ends in the second: 4 x 70 = 280.
			const straddling = 'x'.repeat(245) + 'a' + '\uffff'.repeat(68) + 'b';
			assert.strictEqual(like('%a' + '_'.repeat(68) + 'b%', straddling + 'yz'), true);
			assert.strictEqual(like('%a' + '_'.repeat(68) + 'b%', straddling.slice(0, -1) + 'c' + 'yz'), false);
			for (const ones of [64, 65]) {
				const value = 'a' + '\uffff'.repeat(ones) + 'b';
				assert.strictEqual(like('a' + '_'.repeat(ones) + 'b', value), true);
				assert.strictEqual(like('a' + '_'.repeat(ones) + 'b%', value), true);
				assert.strictEqual(like('%a' + '_'.repeat(ones) + 'b', value), true);
				assert.strictEqual(like('%a' + '_'.repeat(ones) + 'c', value), false);
			}
			assert.strictEqual(like('%a' + run + '\uffff%', 'a' + '\ufffe'.repeat(71)), false);
			assert.strictEqual(like('%a' + run + '\uffff%', 'a' + '\ufffe'.repeat(70) + '\uffff'), true);
			// A literal in another segment rules a placeholder out as well.
			assert.strictEqual(like('%\ufffe%a' + run + 'b', '\ufffe' + 'a' + '\uffff'.repeat(70) + 'b'), true);
			assert.strictEqual(like('%\ufffe%a' + run + '\uffff', '\ufffe' + 'a' + '\ufffe'.repeat(71)), false);
		}
		assert.strictEqual(alasql.utils.like('%[^\uffff]' + run + '%', '\ufffe' + '\uffff'.repeat(70)), true);
		assert.strictEqual(alasql.utils.like('%[\ufffe]%a' + run + 'b', '\ufffe' + 'a' + '\ufdd0'.repeat(70) + 'b'), true);
		// With every noncharacter a literal, no placeholder is left and `_` is written as any unit.
		const noncharacters = ['\uffff', '\ufffe'];
		for (let code = 0xfdd0; code <= 0xfdef; code++) noncharacters.push(String.fromCharCode(code));
		const all = noncharacters.join('');
		for (const tail of ['', '\uffff', 'B']) {
			const value = all + 'a' + all.repeat(3).slice(0, 70) + tail;
			assert.strictEqual(alasql.utils.like('%' + all + '%a' + run + 'b%', value), tail === 'B');
			assert.strictEqual(alasql.utils.like('%' + all + '%a' + run + '%', value), true);
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

	it('treats * as a literal and lets % and _ match line terminators, as legacy does', () => {
		assert.strictEqual(v2Like('a*', 'a*'), true);
		assert.strictEqual(v2Like('a*', 'aaa'), false);
		assert.strictEqual(v2Like('a*', ''), false);
		assert.strictEqual(v2Like('a%b', 'a\nb'), true);
		assert.strictEqual(v2Like('a%b', 'a\u2028b'), true);
		assert.strictEqual(v2Like('a_b', 'a\nb'), true);
		assert.strictEqual(v2Like('a__b', 'a\r\nb'), true);
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

	it('keeps alasql semantics: case-insensitive, ESCAPE and classes; _ matches a line terminator, as in v2', () => {
		assert.deepStrictEqual(select("c LIKE 't0!%' ESCAPE '!'"), ['t0%', 'T0%']);
		assert.deepStrictEqual(select("c LIKE 't0%'"), ['t0%', 't0!z', 't0a', 'T0%']);
		assert.deepStrictEqual(select("c LIKE 't[!_]%'"), ['t_0', 't!x0', 't!_0']);
		assert.deepStrictEqual(select("c LIKE 't[^!_]%'"), ['tx0', 't0%', 't0!z', 't0a', 'T0%']);
		assert.deepStrictEqual(select("c LIKE '[s-u]0_'"), ['t0%', 't0a', 'T0%']);
		assert.strictEqual(alasql.utils.like('a_b', 'a\nb'), true);
		assert.strictEqual(alasql.utils.like('a%b', 'a\nb'), true);
		assert.strictEqual(alasql.utils.like('ABC', 'abc'), true);
		assert.strictEqual(alasql.utils.like('é', 'É'), true);
		assert.strictEqual(alasql.utils.like('s', 'ſ'), false);
		assert.strictEqual(alasql.utils.like('a%', null), false);
		assert.strictEqual(alasql.utils.like('12%', 12345), true);
		// A pattern that is not a string matches nothing, as in v2.
		assert.strictEqual(alasql.utils.like(123, '123'), false);
		assert.throws(() => alasql.utils.like(123, '123', '!!'), ClientError);
		assert.strictEqual(compileExpr(likeExpr(123)).eval({ v: '123' }), null);
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
		// An earlier `[` that never closes leaves a later class intact, whatever pairs the escape forms for it.
		assert.strictEqual(alasql.utils.like('[a[^]', '[ax', '^'), true);
		assert.strictEqual(alasql.utils.like('[a[^]', '[a[]', '^'), false);
		assert.strictEqual(alasql.utils.like('[a![b]', '[', '!'), true);
		assert.strictEqual(alasql.utils.like('[a![b]', '!', '!'), false);
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

	it('matches correctly while evicting cached patterns by total length', () => {
		const body = ('x'.repeat(5_000) + '%').repeat(10);
		const patterns = Array.from({ length: 30 }, (_, i) => '%' + String(i).padStart(2, '0') + body);
		for (let round = 0; round < 2; round++) {
			for (const [i, pattern] of patterns.entries()) {
				assert.strictEqual(alasql.utils.like(pattern, String(i).padStart(2, '0') + 'X'.repeat(50_000)), true);
				assert.strictEqual(alasql.utils.like(pattern, 'nope'), false);
			}
		}
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
		// When `_` stopped at line terminators, a search retrying every start cost value x width (SQA-133).
		['%' + '_'.repeat(10_000) + '%', 'a'.repeat(9_999) + '\n', 1_000_000, '', '', true],
		['%' + '_'.repeat(10_000) + '%', 'a'.repeat(9_998) + '\r\n', 1_000_000, '', '', true],
		['%' + '_'.repeat(10_000) + '%', 'a'.repeat(9_999) + '\u2028', 1_000_000, '', '', true],
		['%' + ('_'.repeat(99) + 'a').repeat(100) + '%', 'a'.repeat(9_999) + '\n', 1_000_000, '', '', true],
		['%' + '_'.repeat(5_000) + '!_' + '_'.repeat(4_999) + '%', 'a'.repeat(9_999) + '\n', 1_000_000, '!'],
		['%a%' + '_'.repeat(10_000) + '%', 'a'.repeat(9_999) + '\n', 1_000_000, '', '', true],
		['%_%', '\n', 1_000_000, '', '', true],
		['%\n' + '_'.repeat(9_998) + '\n%', 'a'.repeat(9_998) + '\n', 1_000_000, '', '', true],
		['%\n' + '_'.repeat(9_998) + '\n%', 'a'.repeat(9_999) + '\n', 1_000_000],
		['%' + '\n'.repeat(5_000) + '_'.repeat(5_000) + '%', '\n', 300_000, '', '', true],
		[
			'%' + '_'.repeat(5_000) + '[^a]' + '_'.repeat(4_999) + '%',
			'a'.repeat(4_998) + '\n',
			1_000_000,
			'',
			'legacy',
			true,
		],
		['%[^\n]' + '_'.repeat(9_999) + '%', 'a'.repeat(9_999) + '\n', 1_000_000, '', 'legacy', true],
		['%[b\n-]' + '_'.repeat(9_999) + '%', 'c', 1_000_000, '', 'legacy'],
		['%' + '_\na'.repeat(3_333) + '%', '\n\na', 1_000_000, '', '', true],
		['%' + 'b\n'.repeat(4_999) + 'b_%', 'b\n', 1_000_000, '', '', true],
		['%' + 'b[\n]'.repeat(4_999) + 'b_%', 'b\n', 1_000_000, '', 'legacy', true],
		// No unit matches a line terminator: only the stretches between them are searched.
		['%' + '[a-z]'.repeat(10_000) + '%', 'a'.repeat(4_999) + '\n', 1_000_000, '', 'legacy'],
		// Every segment fits where it starts, in a value holding the placeholder.
		[('%\n' + '_'.repeat(65)).repeat(1_000) + '%', '\n' + 'a'.repeat(64) + '\uffff', 1_000_000, '', '', true],
		[('%a' + '_'.repeat(65)).repeat(1_000) + '%', 'a', 10_000_000, '', '', true],
		// A row the anchors reject, or accept from a short prefix, costs no pass over a value full of placeholders.
		['a' + '_'.repeat(65) + 'b%', '\uffff', 10_000_000, '', 'legacy'],
		['%a' + '_'.repeat(65) + 'b', '\uffff', 10_000_000, '', 'legacy'],
		['_'.repeat(65) + 'a%', '\uffff'.repeat(65) + 'a', 10_000_000, '', '', true],
		['%a' + '_'.repeat(65) + 'b%', 'a' + '\uffff'.repeat(65) + 'b', 10_000_000, '', '', true],
		// Finding where the line ends must not cost the value for each segment.
		[('%' + 'a'.repeat(65)).repeat(1_000) + '%', 'a', 10_000_000, '', '', true],
	];

	const time = (engine, pattern, valueUnit, valueLength, escape) => {
		const child = spawnSync(process.execPath, [...process.execArgv, fixture], {
			input: JSON.stringify([engine, pattern, valueUnit, valueLength, escape || null]),
			encoding: 'utf8',
			timeout: 20_000,
		});
		assert.strictEqual(child.signal, null, `matcher did not finish within 20 s (${engine})`);
		assert.strictEqual(child.status, 0, child.stderr);
		return JSON.parse(child.stdout);
	};

	it('matches a 10,000-wide middle segment over 20 values of 100,000 characters with line feeds, under 2 s', () => {
		const units = Array.from({ length: 20 }, (_, i) => [
			'a'.repeat([4_999, 9_998, 9_999, 3_332][i % 4]) + '\n',
			100_000,
		]);
		const values = units.map(([unit, length]) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length));
		// [pattern, [offset, character] pairs the rest of the segment leaves to `_`]
		const CASES = [
			['%' + '_'.repeat(10_000) + '%', []],
			[
				'%\n' + '_'.repeat(9_998) + '\n%',
				[
					[0, '\n'],
					[9_999, '\n'],
				],
			],
		];
		const matchesAt = (value, start, literals) => literals.every(([offset, char]) => value[start + offset] === char);
		const reference = (value, literals) => {
			for (let start = 0; start + 10_000 <= value.length; start++) if (matchesAt(value, start, literals)) return true;
			return false;
		};
		for (const [i, [pattern, literals]] of CASES.entries()) {
			const expected = values.map((value) => reference(value, literals));
			if (i === 1) assert.deepStrictEqual(new Set(expected), new Set([true, false]));
			for (const engine of ['v2', 'legacy']) {
				const { result, ms } = time(engine, pattern, units);
				assert.deepStrictEqual(result, expected, engine);
				assert.ok(ms < 2_000, `${engine} took ${ms.toFixed(0)} ms`);
			}
		}
	});

	for (const engine of ['v2', 'legacy']) {
		for (const [pattern, valueUnit, valueLength, escape, only, expected = false] of CASES) {
			if (only && only !== engine) continue;
			const shown = JSON.stringify(pattern.length > 40 ? pattern.slice(0, 40) + '…' : pattern);
			const unitShown = JSON.stringify(valueUnit.length > 2 ? '…' + valueUnit.slice(-2) : valueUnit).replace(
				'\u2028',
				'\\u2028'
			);
			it(`${engine}: ${shown} against ${valueLength.toLocaleString('en-US')} characters of ${unitShown}`, () => {
				const { result, ms } = time(engine, pattern, valueUnit, valueLength, escape);
				assert.strictEqual(result, expected);
				assert.ok(ms < 200, `${engine} took ${ms.toFixed(1)} ms`);
			});
		}
	}
});
