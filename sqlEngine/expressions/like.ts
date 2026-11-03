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
	// No unit accepts a line terminator, so no match contains one.
	lineFree: boolean;
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|/-]/;
const LINE_TERMINATORS = ['\n', '\r', '\u2028', '\u2029'];
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;

// Segment RegExps hold no quantifier or alternation, so they cannot backtrack.
export function compileLikeTokens(tokens: LikeToken[], caseInsensitive = false): LikeMatcher {
	const flags = caseInsensitive ? 'i' : '';
	const segments: Segment[] = [];
	let text: string | undefined = '';
	let units: string[] = [];
	let lineFree = true;
	const endSegment = () => {
		const literal = text !== undefined && (!flags || units.length === 0);
		segments.push({
			width: units.length,
			text: literal ? text : undefined,
			source: units.join(''),
			regExp: undefined,
			lineFree,
		});
		text = '';
		units = [];
		lineFree = true;
	};
	for (const token of tokens) {
		if (token.kind === 'any') {
			endSegment();
			continue;
		}
		if (token.kind === 'literal') {
			if (text !== undefined) text += token.char;
			if (LINE_TERMINATORS.includes(token.char)) lineFree = false;
			units.push(token.char.replace(REGEXP_SYNTAX, '\\$&'));
		} else {
			text = undefined;
			if (token.kind === 'class') {
				const unit = new RegExp(token.source, flags);
				if (LINE_TERMINATORS.some((terminator) => unit.test(terminator))) lineFree = false;
			}
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
	if (segment.text !== undefined) {
		const found = value.indexOf(segment.text, from);
		return found <= lastStart ? found : -1;
	}
	if (!segment.lineFree) return search(segment, value, from, lastStart + segment.width);
	// A start whose window holds a line terminator fails, after scanning up to the segment's width; a
	// RegExp search retries one position later, so values with a line break every <= width characters
	// cost value x width. Search only the stretches between line terminators instead.
	let start = from;
	while (start <= lastStart) {
		LINE_TERMINATOR.lastIndex = start;
		const lineEnd = LINE_TERMINATOR.test(value) ? LINE_TERMINATOR.lastIndex - 1 : value.length;
		if (lineEnd - start >= segment.width) {
			const found = search(segment, value, start, Math.min(lineEnd, lastStart + segment.width));
			if (found >= 0) return found;
		}
		start = lineEnd + 1;
	}
	return -1;
}

// Finds the leftmost match that ends by `end`, without examining any character at or after it.
function search(segment: Segment, value: string, from: number, end: number): number {
	if (end - from < segment.width) return -1;
	const regExp = segment.regExp!;
	regExp.lastIndex = 0;
	return regExp.test(value.slice(from, end)) ? from + regExp.lastIndex - segment.width : -1;
}
