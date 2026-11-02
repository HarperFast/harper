/**
 * SQL LIKE in O(value x pattern) with no backtracking. `%` splits a pattern into fixed-width segments; the first
 * and last are anchored, and each middle segment takes its leftmost fit after the previous one. Leftmost is
 * always safe: any match that places the segment further right still matches with it shifted left.
 */

import { EngineRuntimeError } from '../errors.ts';

export type LikeToken =
	| { kind: 'literal'; char: string }
	| { kind: 'one' }
	| { kind: 'any' }
	| { kind: 'class'; test: (char: string) => boolean };

export type LikeMatcher = (value: string) => boolean;

export interface LikeMatchOptions {
	/** RegExp `i` comparison, as alasql's LIKE. */
	caseInsensitive?: boolean;
	/** `_` as a RegExp `.`, as alasql's LIKE. */
	oneExcludesLineTerminators?: boolean;
}

/** An escape followed by any character is that character literally. */
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
	/** Set when every unit is a literal, so the segment can be found with `indexOf`. */
	text: string | undefined;
	units: (string | ((char: string) => boolean))[];
}

const anyChar = () => true;
const notLineTerminator = (char: string) => char !== '\n' && char !== '\r' && char !== '\u2028' && char !== '\u2029';

export function compileLikeTokens(tokens: LikeToken[], options: LikeMatchOptions = {}): LikeMatcher {
	const caseInsensitive = options.caseInsensitive === true;
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
			const char = caseInsensitive ? canonicalizeCase(token.char) : token.char;
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
		return (value) => value.length === only.width && segmentMatchesAt(only, value, 0, caseInsensitive);
	}
	const first = segments[0];
	const last = segments[segments.length - 1];
	const middle = segments.slice(1, -1).filter((segment) => segment.width > 0);
	return (value) => {
		const end = value.length - last.width;
		if (end < first.width) return false;
		if (!segmentMatchesAt(first, value, 0, caseInsensitive) || !segmentMatchesAt(last, value, end, caseInsensitive)) {
			return false;
		}
		if (middle.length === 0) return true;
		const folded = caseInsensitive ? canonicalizeString(value) : value;
		let position = first.width;
		for (const segment of middle) {
			const found = findSegment(segment, folded, position, end - segment.width);
			if (found < 0) return false;
			position = found + segment.width;
		}
		return true;
	};
}

function segmentMatchesAt(segment: Segment, value: string, start: number, fold: boolean): boolean {
	const units = segment.units;
	for (let i = 0; i < units.length; i++) {
		const unit = units[i];
		const char = value[start + i];
		if (typeof unit === 'string') {
			if (unit !== (fold ? canonicalizeCase(char) : char)) return false;
		} else if (!unit(char)) return false;
	}
	return true;
}

function findSegment(segment: Segment, value: string, from: number, lastStart: number): number {
	if (segment.text !== undefined) {
		const found = value.indexOf(segment.text, from);
		return found <= lastStart ? found : -1;
	}
	for (let start = from; start <= lastStart; start++) {
		if (segmentMatchesAt(segment, value, start, false)) return start;
	}
	return -1;
}

function isAscii(value: string): boolean {
	for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 127) return false;
	return true;
}

/**
 * Canonicalize of a non-Unicode case-insensitive RegExp, per code unit: the length never changes, and a
 * non-ASCII unit never folds to ASCII (U+017F stays distinct from `s`), unlike `toUpperCase` on the whole string.
 */
function canonicalizeString(value: string): string {
	if (isAscii(value)) return value.toUpperCase();
	let folded = '';
	for (let i = 0; i < value.length; i++) folded += canonicalizeCase(value[i]);
	return folded;
}

function canonicalizeCase(char: string): string {
	const code = char.charCodeAt(0);
	if (code < 128) return code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : char;
	const upper = char.toUpperCase();
	if (upper.length !== 1 || upper.charCodeAt(0) < 128) return char;
	return upper;
}
