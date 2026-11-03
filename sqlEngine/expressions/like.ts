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
	// Offsets of each run of `_`.
	ones: { start: number; end: number }[];
	// Matches, in the value with each line terminator replaced by U+FFFF, at least wherever the segment
	// matches in the value, so it finds candidates without meeting a line terminator.
	relaxedSource: string;
	relaxed: RegExp | undefined;
	sticky: RegExp | undefined;
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|/-]/;
const LINE_TERMINATORS = ['\n', '\r', '\u2028', '\u2029'];
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;
// A search retrying every start costs at most the width per start; up to this width that is cheaper than
// stopping at each line terminator (~100 ns each on V8).
const DIRECT_SEARCH_WIDTH = 64;

// Segment RegExps hold no quantifier or alternation, so they cannot backtrack.
export function compileLikeTokens(tokens: LikeToken[], caseInsensitive = false): LikeMatcher {
	const flags = caseInsensitive ? 'i' : '';
	const segments: Segment[] = [];
	let text: string | undefined = '';
	let units: string[] = [];
	let relaxedUnits: string[] = [];
	let lineFree = true;
	let ones: Segment['ones'] = [];
	const endSegment = () => {
		const literal = text !== undefined && (!flags || units.length === 0);
		segments.push({
			width: units.length,
			text: literal ? text : undefined,
			source: units.join(''),
			regExp: undefined,
			lineFree,
			ones,
			relaxedSource: relaxedUnits.join(''),
			relaxed: undefined,
			sticky: undefined,
		});
		text = '';
		units = [];
		relaxedUnits = [];
		lineFree = true;
		ones = [];
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
			relaxedUnits.push(LINE_TERMINATORS.includes(token.char) ? '\\uffff' : units.at(-1)!);
		} else {
			text = undefined;
			let relaxedUnit = token.kind === 'class' ? token.source : '.';
			if (token.kind === 'class') {
				const unit = new RegExp(token.source, flags);
				if (LINE_TERMINATORS.some((terminator) => unit.test(terminator))) {
					lineFree = false;
					if (!unit.test('\uffff')) {
						relaxedUnit = token.source[1] === '^' ? '.' : token.source.slice(0, -1) + '\\uffff]';
					}
				}
			}
			if (token.kind === 'one') {
				const run = ones.at(-1);
				if (run?.end === units.length) run.end++;
				else ones.push({ start: units.length, end: units.length + 1 });
			}
			units.push(token.kind === 'one' ? '.' : token.source);
			relaxedUnits.push(relaxedUnit);
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
		if (segment.text !== undefined) continue;
		segment.regExp = new RegExp(segment.source, flags + 'g');
		if (!segment.lineFree && segment.ones.length > 0) {
			segment.relaxed = new RegExp(segment.relaxedSource, flags + 'g');
			segment.sticky = new RegExp(segment.source, flags + 'y');
		}
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
	const end = lastStart + segment.width;
	if (segment.width <= DIRECT_SEARCH_WIDTH) return search(segment.regExp!, segment.width, value, from, end);
	// A start whose window puts a line terminator on a `_` fails after scanning up to the segment's width,
	// and a RegExp search retries one position later: values with a line break every <= width characters
	// cost value x width. So no RegExp here meets a `_` that a line terminator fails.
	if (segment.lineFree) {
		// No match holds a line terminator: search only the stretches between them.
		let start = from;
		while (start <= lastStart) {
			LINE_TERMINATOR.lastIndex = start;
			const lineEnd = LINE_TERMINATOR.test(value) ? LINE_TERMINATOR.lastIndex - 1 : value.length;
			const found = search(segment.regExp!, segment.width, value, start, Math.min(lineEnd, end));
			if (found >= 0) return found;
			start = lineEnd + 1;
		}
		return -1;
	}
	if (!segment.relaxed) return search(segment.regExp!, segment.width, value, from, end);
	// A unit here matches a line terminator, so a match can hold one. Search for candidates where line
	// terminators cannot fail, move each run of `_` past any it covers, then confirm.
	const relaxedValue = value.replace(LINE_TERMINATOR, '\uffff');
	const previousTerminator = previousLineTerminators(value);
	const clearFrom = (start: number) => clearOfLineTerminators(segment.ones, previousTerminator, start, lastStart);
	let start = clearFrom(from);
	while (start <= lastStart) {
		const found = search(segment.relaxed, segment.width, relaxedValue, start, end);
		if (found < 0) return -1;
		start = clearFrom(found);
		if (start !== found) continue;
		const sticky = segment.sticky!;
		sticky.lastIndex = found;
		if (sticky.test(value)) return found;
		start = clearFrom(found + 1);
	}
	return -1;
}

// Finds the leftmost match that ends by `end`, without examining any character at or after it.
function search(regExp: RegExp, width: number, value: string, from: number, end: number): number {
	if (end - from < width) return -1;
	regExp.lastIndex = 0;
	return regExp.test(value.slice(from, end)) ? from + regExp.lastIndex - width : -1;
}

// The first start from `start` at which no run of `_` covers a line terminator. Each move puts the last
// terminator a run covers just before it; every start skipped still has that terminator in that run.
function clearOfLineTerminators(
	ones: Segment['ones'],
	previousTerminator: Int32Array,
	start: number,
	lastStart: number
): number {
	for (let i = 0, clear = 0; clear < ones.length && start <= lastStart;) {
		const run = ones[i];
		const terminator = previousTerminator[start + run.end];
		if (terminator >= start + run.start) {
			start = terminator - run.start + 1;
			clear = 0;
		} else {
			clear++;
			i = (i + 1) % ones.length;
		}
	}
	return start;
}

// Index p holds the position of the last line terminator before p, or -1.
function previousLineTerminators(value: string): Int32Array {
	const index = new Int32Array(value.length + 1);
	let previous = -1;
	for (let i = 0; i < value.length; i++) {
		index[i] = previous;
		const code = value.charCodeAt(i);
		if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) previous = i;
	}
	index[value.length] = previous;
	return index;
}
