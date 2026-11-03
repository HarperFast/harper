import { ClientError } from '../utility/errors/hdbError.ts';
import {
	compileLikeTokens,
	LIKE_SEGMENT_TOO_WIDE,
	MAX_LIKE_SEGMENT_WIDTH,
	type LikeMatcher,
	type LikeToken,
} from '../sqlEngine/expressions/like.ts';

const MAX_CACHED_PATTERNS = 1000;
// A matcher holds RegExps about as long as its pattern.
const MAX_CACHED_LENGTH = 1_000_000;
const cacheByEscape = new Map<string, Map<string, LikeMatcher>>();
let cachedPatterns = 0;
let cachedLength = 0;

// alasql passes no escape argument when the LIKE has no ESCAPE clause.
function alasqlLike(pattern: unknown, value: unknown, escape?: unknown): boolean {
	// As in v2, which makes it UNKNOWN; alasql's own matcher matched only '' for one.
	if (pattern != null && typeof pattern !== 'string') return false;
	const patternText = typeof pattern === 'string' ? pattern : '';
	if (escape !== undefined && (typeof escape !== 'string' || escape.length !== 1)) {
		throw new ClientError(`LIKE ESCAPE must be a single character, got ${JSON.stringify(escape)}`);
	}
	const escapeText = escape === undefined ? '' : (escape as string);
	let matches = cacheByEscape.get(escapeText)?.get(patternText);
	if (!matches) {
		matches = compileLikeTokens(tokenizeAlasqlLike(patternText, escapeText), true);
		while (
			cachedPatterns > 0 &&
			(cachedPatterns >= MAX_CACHED_PATTERNS || cachedLength + patternText.length > MAX_CACHED_LENGTH)
		) {
			evictOldestPattern();
		}
		let cache = cacheByEscape.get(escapeText);
		if (!cache) cacheByEscape.set(escapeText, (cache = new Map()));
		cache.set(patternText, matches);
		cachedPatterns++;
		cachedLength += patternText.length;
	}
	return matches('' + (value ?? ''));
}

function evictOldestPattern(): void {
	const [escape, cache] = cacheByEscape.entries().next().value!;
	const pattern = cache.keys().next().value!;
	cache.delete(pattern);
	if (cache.size === 0) cacheByEscape.delete(escape);
	cachedPatterns--;
	cachedLength -= pattern.length;
}

function tokenizeAlasqlLike(pattern: string, escape: string): LikeToken[] {
	const tokens: LikeToken[] = [];
	// Once no closing `]` remains, every later `[` is a literal: searching again would make the scan quadratic.
	let unclosed = false;
	let width = 0;
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === '%' && char !== escape) {
			tokens.push({ kind: 'any' });
			width = 0;
			continue;
		}
		if (++width > MAX_LIKE_SEGMENT_WIDTH) throw new ClientError(LIKE_SEGMENT_TOO_WIDE);
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
			tokens.push({ kind: 'class', source: classSource(pattern.slice(i + 1, close), escape) });
			i = close;
		} else if (char === '_') tokens.push({ kind: 'one' });
		else tokens.push({ kind: 'literal', char });
	}
	return tokens;
}

function findClassEnd(pattern: string, from: number, escape: string): number {
	for (let i = pattern[from] === '^' ? from + 1 : from; i < pattern.length; i++) {
		if (pattern[i] === escape) i++;
		else if (pattern[i] === ']') return i;
	}
	return -1;
}

function classSource(body: string, escape: string): string {
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
	const classText = `[${negated ? '^' : ''}${source}]`;
	try {
		new RegExp(classText);
	} catch (error) {
		throw new ClientError(`invalid character class [${body}] in LIKE pattern: ${(error as Error).message}`);
	}
	return classText;
}

const ESCAPE_SERIALIZED = Symbol('harperLikeEscapeSerialized');

/** Legacy SQL re-parses `where.toString()`, and alasql's `Op#toString` drops `ESCAPE`. */
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
