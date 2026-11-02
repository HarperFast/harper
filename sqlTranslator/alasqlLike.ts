/**
 * alasql's own LIKE compiles each pattern to a backtracking RegExp (#1930). This keeps its semantics
 * (case-insensitive, `_` excludes line terminators, `[set]` classes) on the linear matcher; characters alasql
 * leaked into that RegExp unescaped (`\`, `^`, `$`, escape + letter) are literals here.
 */

import { ClientError } from '../utility/errors/hdbError.ts';
import { compileLikeTokens, type LikeMatcher, type LikeToken } from '../sqlEngine/expressions/like.ts';

const MAX_CACHED_PATTERNS = 1000;
const cacheByEscape = new Map<string, Map<string, LikeMatcher>>();

function alasqlLike(pattern: unknown, value: unknown, escape: unknown = ''): boolean {
	const patternText = String(pattern ?? '');
	const escapeText = String(escape ?? '');
	let cache = cacheByEscape.get(escapeText);
	if (!cache) cacheByEscape.set(escapeText, (cache = new Map()));
	let matches = cache.get(patternText);
	if (!matches) {
		if (cache.size >= MAX_CACHED_PATTERNS) cache.clear();
		matches = compileLikeTokens(tokenizeAlasqlLike(patternText, escapeText), {
			caseInsensitive: true,
			oneExcludesLineTerminators: true,
		});
		cache.set(patternText, matches);
	}
	return matches('' + (value ?? ''));
}

function tokenizeAlasqlLike(pattern: string, escape: string): LikeToken[] {
	if (escape.length > 1) throw new ClientError(`LIKE ESCAPE must be a single character, got '${escape}'`);
	const tokens: LikeToken[] = [];
	// Once no closing `]` remains, every later `[` is a literal: searching again would make the scan quadratic.
	let unclosed = false;
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === escape) {
			if (++i === pattern.length) {
				throw new ClientError(`LIKE pattern must not end with the escape character '${escape}'`);
			}
			tokens.push({ kind: 'literal', char: pattern[i] });
		} else if (char === '[' && !unclosed) {
			const close = findClassEnd(pattern, i + 1, escape);
			if (close < 0) {
				unclosed = true;
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

function findClassEnd(pattern: string, from: number, escape: string): number {
	for (let i = from; i < pattern.length; i++) {
		if (pattern[i] === escape) i++;
		else if (pattern[i] === ']') return i;
	}
	return -1;
}

/** A `[...]` body: a leading `^` negates, `a-z` is a range, an escaped or any other character is literal. */
function compileClass(body: string, escape: string): (char: string) => boolean {
	const negated = body[0] === '^';
	let source = '';
	for (let i = negated ? 1 : 0; i < body.length; i++) {
		let char = body[i];
		if (char === escape) char = body[++i];
		else if (char === '-') {
			source += '-';
			continue;
		}
		source += /[\\\]^[-]/.test(char) ? '\\' + char : char;
	}
	let regex: RegExp;
	try {
		regex = new RegExp(`^[${negated ? '^' : ''}${source}]$`, 'i');
	} catch (error) {
		throw new ClientError(`invalid character class [${body}] in LIKE pattern: ${(error as Error).message}`);
	}
	return (char) => regex.test(char);
}

const ESCAPE_SERIALIZED = Symbol('harperLikeEscapeSerialized');

/**
 * Also makes `Op#toString` keep a LIKE's `ESCAPE`: legacy SQL re-parses `where.toString()`
 * (SQLSearch `_buildSQL`, `update.ts`, `deleteTranslator.ts`), and alasql's serialization drops it.
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
