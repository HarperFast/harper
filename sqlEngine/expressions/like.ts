// Leftmost placement of each middle segment is always safe: any match that places it further right still
// matches with it shifted left, so no position is revisited.

import { EngineRuntimeError } from '../errors.ts';

export type LikeToken =
	{ kind: 'literal'; char: string } | { kind: 'one' } | { kind: 'any' } | { kind: 'class'; source: string };

export type LikeMatcher = (value: string) => boolean;

// Each segment between `%` wildcards becomes one RegExp, and V8 fails to compile one of about 50k atoms (only on
// its first exec, not at construction).
export const MAX_LIKE_SEGMENT_WIDTH = 10_000;
export const LIKE_SEGMENT_TOO_WIDE = `LIKE pattern must not have more than ${MAX_LIKE_SEGMENT_WIDTH} characters between % wildcards`;

export function tokenizeLike(pattern: string, escape?: string): LikeToken[] {
	const tokens: LikeToken[] = [];
	let width = 0;
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === '%' && char !== escape) {
			tokens.push({ kind: 'any' });
			width = 0;
			continue;
		}
		if (++width > MAX_LIKE_SEGMENT_WIDTH) throw new EngineRuntimeError(LIKE_SEGMENT_TOO_WIDE);
		if (char === escape) {
			if (++i === pattern.length) {
				throw new EngineRuntimeError(`LIKE pattern must not end with the escape character '${escape}'`);
			}
			tokens.push({ kind: 'literal', char: pattern[i] });
		} else if (char === '_') tokens.push({ kind: 'one' });
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
	text: string | undefined;
	source: string;
	regExp: RegExp | undefined;
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|/-]/;

// Segment RegExps hold no quantifier or alternation, so they cannot backtrack.
export function compileLikeTokens(tokens: LikeToken[], caseInsensitive = false): LikeMatcher {
	const flags = caseInsensitive ? 'i' : '';
	const segments: Segment[] = [];
	let text: string | undefined = '';
	let units: string[] = [];
	const endSegment = () => {
		const literal = text !== undefined && (!flags || units.length === 0);
		segments.push({ width: units.length, text: literal ? text : undefined, source: units.join(''), regExp: undefined });
		text = '';
		units = [];
	};
	for (const token of tokens) {
		if (token.kind === 'any') {
			endSegment();
			continue;
		}
		if (token.kind === 'literal') {
			if (text !== undefined) text += token.char;
			units.push(token.char.replace(REGEXP_SYNTAX, '\\$&'));
		} else {
			text = undefined;
			units.push(token.kind === 'one' ? '.' : token.source);
		}
	}
	endSegment();

	const first = segments[0];
	const last = segments[segments.length - 1];
	const middle = segments.slice(1, -1).filter((segment) => segment.width > 0);
	for (const segment of new Set([first, last])) {
		if (segment.text === undefined) segment.regExp = new RegExp(segment.source, flags + 'y');
	}
	for (const segment of middle) {
		if (segment.text === undefined) segment.regExp = new RegExp(segment.source, flags + 'g');
	}
	if (segments.length === 1) {
		return (value) => value.length === first.width && segmentMatchesAt(first, value, 0);
	}
	return (value) => {
		const end = value.length - last.width;
		if (end < first.width || !segmentMatchesAt(first, value, 0) || !segmentMatchesAt(last, value, end)) return false;
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
	if (segment.text !== undefined) return value.startsWith(segment.text, start);
	const sticky = segment.regExp!;
	sticky.lastIndex = start;
	return sticky.test(value);
}

function findSegment(segment: Segment, value: string, from: number, lastStart: number): number {
	let found: number;
	if (segment.text !== undefined) found = value.indexOf(segment.text, from);
	else {
		const search = segment.regExp!;
		search.lastIndex = from;
		found = search.test(value) ? search.lastIndex - segment.width : -1;
	}
	return found <= lastStart ? found : -1;
}
