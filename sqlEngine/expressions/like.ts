/**
 * SQL LIKE, matched in O(value length × pattern length) with no backtracking.
 *
 * A pattern is tokenized once into literal characters, `_` (one character) and
 * `%` (any run). Splitting on `%` leaves fixed-width segments: the first is
 * anchored at the start, the last at the end, and each middle segment is placed
 * at its leftmost fit after the previous one. Leftmost placement is never wrong
 * for fixed-width segments separated by `%`, since any later solution can shift
 * that segment left without disturbing the rest — so no position is revisited.
 */

import { EngineRuntimeError } from '../errors.ts';

export type LikeToken =
	| { kind: 'literal'; char: string }
	| { kind: 'one' }
	| { kind: 'any' }
	| { kind: 'class'; test: (char: string) => boolean };

export type LikeMatcher = (value: string) => boolean;

export interface LikeMatchOptions {
	/** Compare by regex `i` canonicalization (alasql's case-insensitive LIKE). */
	caseInsensitive?: boolean;
	/** `_` does not match `\n`, `\r`, U+2028 or U+2029 (alasql's `_` is a regex `.`). */
	oneExcludesLineTerminators?: boolean;
}

/** Tokenizes a v2 SQL LIKE pattern; an escape followed by any character is that character literally. */
export function tokenizeLike(pattern: string, escape?: string): LikeToken[] {
	const tokens: LikeToken[] = [];
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === escape) {
			if (++i === pattern.length) {
				throw new EngineRuntimeError(`LIKE pattern must not end with the escape character '${escape}'`);
			}
			tokens.push({ kind: 'literal', char: pattern[i] });
		} else if (char === '%') tokens.push({ kind: 'any' });
		else if (char === '_') tokens.push({ kind: 'one' });
		else tokens.push({ kind: 'literal', char });
	}
	return tokens;
}

/** Validates the ESCAPE operand of a LIKE: exactly one character. */
export function assertLikeEscape(escape: unknown): asserts escape is string {
	if (typeof escape !== 'string' || escape.length !== 1) {
		throw new EngineRuntimeError(`LIKE ESCAPE must be a single character, got ${JSON.stringify(escape)}`);
	}
}

export function compileLike(pattern: string, escape?: string): LikeMatcher {
	return compileLikeTokens(tokenizeLike(pattern, escape));
}

interface Segment {
	width: number;
	/** Set when every unit is a literal: the segment is found with `indexOf`. */
	text: string | undefined;
	units: (string | ((char: string) => boolean))[];
}

const anyChar = () => true;
const notLineTerminator = (char: string) => char !== '\n' && char !== '\r' && char !== ' ' && char !== ' ';

export function compileLikeTokens(tokens: LikeToken[], options: LikeMatchOptions = {}): LikeMatcher {
	const fold = options.caseInsensitive ? canonicalizeCase : undefined;
	const one = options.oneExcludesLineTerminators ? notLineTerminator : anyChar;
	const segments: Segment[] = [];
	let current: Segment = { width: 0, text: '', units: [] };
	for (const token of tokens) {
		if (token.kind === 'any') {
			segments.push(current);
			current = { width: 0, text: '', units: [] };
			continue;
		}
		current.width++;
		if (token.kind === 'literal') {
			const char = fold ? fold(token.char) : token.char;
			current.units.push(char);
			if (current.text !== undefined) current.text += char;
		} else {
			current.units.push(token.kind === 'one' ? one : token.test);
			current.text = undefined;
		}
	}
	segments.push(current);

	if (segments.length === 1) {
		const only = segments[0];
		return (input) => {
			const value = fold ? canonicalizeString(input) : input;
			return value.length === only.width && segmentMatchesAt(only, value, 0);
		};
	}
	const first = segments[0];
	const last = segments[segments.length - 1];
	const middle = segments.slice(1, -1).filter((segment) => segment.width > 0);
	return (input) => {
		const value = fold ? canonicalizeString(input) : input;
		const end = value.length - last.width;
		if (end < first.width) return false;
		if (!segmentMatchesAt(first, value, 0) || !segmentMatchesAt(last, value, end)) return false;
		let position = first.width;
		for (const segment of middle) {
			const found = findSegment(segment, value, position, end - segment.width);
			if (found < 0) return false;
			position = found + segment.width;
		}
		return true;
	};
}

function segmentMatchesAt(segment: Segment, value: string, start: number): boolean {
	const units = segment.units;
	for (let i = 0; i < units.length; i++) {
		const unit = units[i];
		const char = value[start + i];
		if (typeof unit === 'string' ? unit !== char : !unit(char)) return false;
	}
	return true;
}

function findSegment(segment: Segment, value: string, from: number, lastStart: number): number {
	if (segment.text !== undefined) {
		const found = value.indexOf(segment.text, from);
		return found <= lastStart ? found : -1;
	}
	for (let start = from; start <= lastStart; start++) {
		if (segmentMatchesAt(segment, value, start)) return start;
	}
	return -1;
}

const NON_ASCII = /[\u0080-\uffff]/;

/**
 * The per-code-unit Canonicalize of a non-Unicode case-insensitive RegExp: never
 * changes the string length, and never folds a non-ASCII unit to ASCII (so `ſ`
 * stays distinct from `s`), unlike `String.prototype.toUpperCase` on the whole string.
 */
export function canonicalizeString(value: string): string {
	if (!NON_ASCII.test(value)) return value.toUpperCase();
	let folded = '';
	for (let i = 0; i < value.length; i++) folded += canonicalizeCase(value[i]);
	return folded;
}

function canonicalizeCase(char: string): string {
	const upper = char.toUpperCase();
	if (upper.length !== 1) return char;
	if (char.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) return char;
	return upper;
}
