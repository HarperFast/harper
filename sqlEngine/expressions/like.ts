/**
 * SQL LIKE in O(value x pattern) with no backtracking. `%` splits a pattern into fixed-width segments; the first
 * and last are anchored, and each middle segment takes its leftmost fit after the previous one. Leftmost is
 * always safe: any match that places the segment further right still matches with it shifted left.
 */

import { ClientError } from '../../utility/errors/hdbError.ts';
import { EngineRuntimeError } from '../errors.ts';

export type LikeToken =
	{ kind: 'literal'; char: string } | { kind: 'one' } | { kind: 'any' } | { kind: 'class'; source: string };

export type LikeMatcher = (value: string) => boolean;

export interface LikeMatchOptions {
	caseInsensitive?: boolean;
	oneExcludesLineTerminators?: boolean;
}

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
	/** Literal text, matched with `startsWith`/`indexOf` when the comparison is case-sensitive. */
	text: string | undefined;
	sticky: RegExp | undefined;
	global: RegExp | undefined;
}

export function compileLikeTokens(tokens: LikeToken[], options: LikeMatchOptions = {}): LikeMatcher {
	const flags = options.caseInsensitive ? 'i' : '';
	const one = options.oneExcludesLineTerminators ? '.' : '[\\s\\S]';
	const segments: Segment[] = [];
	let width = 0;
	let text: string | undefined = '';
	let source = '';
	const endSegment = () => {
		const literal = text !== undefined && (!flags || width === 0);
		// V8 fails to compile a RegExp of roughly 50k atoms, and only on its first match.
		if (!literal && width > MAX_REGEXP_SEGMENT) {
			throw new ClientError(`LIKE pattern has a ${width}-character run between %s; the limit is ${MAX_REGEXP_SEGMENT}`);
		}
		segments.push({
			width,
			text: literal ? text : undefined,
			sticky: literal ? undefined : new RegExp(source, flags + 'y'),
			global: literal ? undefined : new RegExp(source, flags + 'g'),
		});
		width = 0;
		text = '';
		source = '';
	};
	for (const token of tokens) {
		if (token.kind === 'any') {
			endSegment();
			continue;
		}
		width++;
		if (token.kind === 'literal') {
			if (text !== undefined) text += token.char;
			source += token.char.replace(REGEXP_SYNTAX, '\\$&');
		} else {
			text = undefined;
			source += token.kind === 'one' ? one : token.source;
		}
	}
	endSegment();

	if (segments.length === 1) {
		const only = segments[0];
		return (value) => value.length === only.width && segmentMatchesAt(only, value, 0);
	}
	const first = segments[0];
	const last = segments[segments.length - 1];
	const middle = segments.slice(1, -1).filter((segment) => segment.width > 0);
	return (value) => {
		const end = value.length - last.width;
		if (end < first.width || !segmentMatchesAt(first, value, 0) || !segmentMatchesAt(last, value, end)) return false;
		let position = first.width;
		for (const segment of middle) {
			const found = findSegment(segment, value, position);
			if (found < 0 || found > end - segment.width) return false;
			position = found + segment.width;
		}
		return true;
	};
}

// Segment RegExps hold no quantifier or alternation, so they cannot backtrack.
const MAX_REGEXP_SEGMENT = 10_000;
const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|/-]/;

function segmentMatchesAt(segment: Segment, value: string, start: number): boolean {
	if (segment.text !== undefined) return value.startsWith(segment.text, start);
	segment.sticky!.lastIndex = start;
	return segment.sticky!.test(value);
}

function findSegment(segment: Segment, value: string, from: number): number {
	if (segment.text !== undefined) return value.indexOf(segment.text, from);
	const regex = segment.global!;
	regex.lastIndex = from;
	return regex.test(value) ? regex.lastIndex - segment.width : -1;
}
