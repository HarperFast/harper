/**
 * Linear-time replacement for alasql's LIKE (`alasql.utils.like`), which compiles
 * each pattern to a backtracking RegExp (`%` → `[\s\S]*`) that a crafted pattern
 * drives into polynomial time (harper#1930).
 *
 * alasql's semantics are kept: case-insensitive, `_` does not match a line
 * terminator, `[set]` / `[^set]` classes with ranges. Characters alasql leaked
 * into its RegExp unescaped (`\`, `^`, `$`, and escape + letter such as `!d`
 * becoming `\d`) are literals here, as is a `[` with no closing `]` (alasql threw).
 */

import { compileLikeTokens, type LikeMatcher, type LikeToken } from '../sqlEngine/expressions/like.ts';

const MAX_CACHED_PATTERNS = 1000;
const cache = new Map<string, LikeMatcher>();

export function alasqlLike(pattern: unknown, value: unknown, escape: unknown = ''): boolean {
	const patternText = String(pattern ?? '');
	const escapeText = String(escape ?? '');
	const key = escapeText.length + ':' + escapeText + patternText;
	let matches = cache.get(key);
	if (!matches) {
		if (cache.size >= MAX_CACHED_PATTERNS) cache.clear();
		matches = compileLikeTokens(tokenizeAlasqlLike(patternText, escapeText), {
			caseInsensitive: true,
			oneExcludesLineTerminators: true,
		});
		cache.set(key, matches);
	}
	return matches('' + (value ?? ''));
}

export function tokenizeAlasqlLike(pattern: string, escape: string): LikeToken[] {
	const tokens: LikeToken[] = [];
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === escape && i + 1 < pattern.length) {
			tokens.push({ kind: 'literal', char: pattern[++i] });
		} else if (char === '[') {
			const close = pattern.indexOf(']', i + 1);
			if (close < 0) {
				tokens.push({ kind: 'literal', char });
				continue;
			}
			tokens.push({ kind: 'class', test: compileClass(pattern.slice(i + 1, close), escape) });
			i = close;
		} else if (char === '%') tokens.push({ kind: 'any' });
		else if (char === '_') tokens.push({ kind: 'one' });
		else tokens.push({ kind: 'literal', char });
	}
	return tokens;
}

/** One `[...]` body as a single-character RegExp: `^` negates, `a-z` is a range, everything else is literal. */
function compileClass(body: string, escape: string): (char: string) => boolean {
	let negated = false;
	let start = 0;
	if (body[0] === '^') {
		negated = true;
		start = 1;
	}
	let source = '';
	for (let i = start; i < body.length; i++) {
		let char = body[i];
		if (char === escape && i + 1 < body.length) char = body[++i];
		else if (char === '-') {
			source += '-';
			continue;
		}
		source += /[\\\]^[-]/.test(char) ? '\\' + char : char;
	}
	const regex = new RegExp(`^[${negated ? '^' : ''}${source}]$`, 'i');
	return (char) => regex.test(char);
}

const ESCAPE_SERIALIZED = Symbol('harperLikeEscapeSerialized');

/**
 * Points alasql's LIKE at {@link alasqlLike}, and makes `Op#toString` keep a LIKE's
 * `ESCAPE` clause: legacy SQL re-parses `where.toString()` (SQLSearch `_buildSQL`,
 * `update.ts`, `deleteTranslator.ts`), and alasql's own serialization drops it.
 */
export function installAlasqlLike(alasql: any): void {
	alasql.utils.like = alasqlLike;
	const opPrototype = alasql.yy.Op.prototype;
	if (opPrototype[ESCAPE_SERIALIZED]) return;
	const toString = opPrototype.toString;
	opPrototype.toString = function (this: any) {
		const text = toString.call(this);
		return this.escape && (this.op === 'LIKE' || this.op === 'NOT LIKE')
			? `${text} ESCAPE ${this.escape.toString()}`
			: text;
	};
	opPrototype[ESCAPE_SERIALIZED] = true;
}
