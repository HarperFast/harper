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
	// No unit matches a line terminator, so no match contains one.
	lineFree: boolean;
	// Offsets of each run of `_`.
	ones: { start: number; end: number }[];
	// The segment with each `_` as `[^placeholder]`, which also matches line terminators. Every other unit
	// treats the placeholder and its substitute alike, so in a value with each placeholder replaced by the
	// substitute it matches wherever the segment would if `_` matched line terminators.
	relaxed: RegExp | undefined;
	placeholder: string;
	substitute: string;
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|/-]/;
const LINE_TERMINATORS = ['\n', '\r', '\u2028', '\u2029'];
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;
// A search retrying every start costs at most the width per start; up to this width that is cheaper than
// stopping at each line terminator (~100 ns each on V8).
const DIRECT_SEARCH_WIDTH = 64;
const RELAXED_BUDGET = 8;
// Noncharacters: no case mapping reaches them. `[^]` cannot stand for `_` here: under `i`, V8 compiles each
// one about 100x slower than `.`.
const PLACEHOLDERS = ['\uffff', '\ufffe'];
for (let code = 0xfdd0; code <= 0xfdef; code++) PLACEHOLDERS.push(String.fromCharCode(code));

// Segment RegExps hold no quantifier or alternation, so they cannot backtrack.
export function compileLikeTokens(tokens: LikeToken[], caseInsensitive = false): LikeMatcher {
	const flags = caseInsensitive ? 'i' : '';
	const segments: Segment[] = [];
	let text: string | undefined = '';
	let units: string[] = [];
	let lineFree = true;
	let ones: Segment['ones'] = [];
	let literals = new Set<string>();
	let classes: RegExp[] = [];
	const endSegment = () => {
		const literal = text !== undefined && (!flags || units.length === 0);
		const segment: Segment = {
			width: units.length,
			text: literal ? text : undefined,
			source: units.join(''),
			regExp: undefined,
			lineFree,
			ones,
			relaxed: undefined,
			placeholder: '',
			substitute: '',
		};
		if (!literal && !lineFree && ones.length > 0 && units.length > DIRECT_SEARCH_WIDTH) {
			const pair = placeholderPair(literals, classes);
			if (pair) {
				segment.placeholder = pair[0];
				segment.substitute = pair[1];
				const one = `[^\\u${pair[0].charCodeAt(0).toString(16)}]`;
				const relaxedUnits = units.slice();
				for (const run of ones) relaxedUnits.fill(one, run.start, run.end);
				segment.relaxed = new RegExp(relaxedUnits.join(''), flags + 'g');
			}
		}
		segments.push(segment);
		text = '';
		units = [];
		lineFree = true;
		ones = [];
		literals = new Set();
		classes = [];
	};
	for (const token of tokens) {
		if (token.kind === 'any') {
			endSegment();
			continue;
		}
		if (token.kind === 'literal') {
			if (text !== undefined) text += token.char;
			if (LINE_TERMINATORS.includes(token.char)) lineFree = false;
			literals.add(token.char);
			units.push(token.char.replace(REGEXP_SYNTAX, '\\$&'));
		} else {
			text = undefined;
			if (token.kind === 'class') {
				const unit = new RegExp(token.source, flags);
				if (LINE_TERMINATORS.some((terminator) => unit.test(terminator))) lineFree = false;
				classes.push(unit);
			} else {
				const run = ones.at(-1);
				if (run?.end === units.length) run.end++;
				else ones.push({ start: units.length, end: units.length + 1 });
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

// Two placeholders that no literal is and that every class accepts both or neither of.
function placeholderPair(literals: Set<string>, classes: RegExp[]): [string, string] | undefined {
	const usable = PLACEHOLDERS.filter((placeholder) => !literals.has(placeholder));
	for (let i = 0; i < usable.length; i++) {
		for (let j = i + 1; j < usable.length; j++) {
			if (classes.every((unit) => unit.test(usable[i]) === unit.test(usable[j]))) return [usable[i], usable[j]];
		}
	}
	return undefined;
}

function segmentMatchesAt(segment: Segment, value: string, start: number): boolean {
	if (segment.text !== undefined) return value.startsWith(segment.text, start);
	const sticky = segment.regExp!;
	sticky.lastIndex = start;
	return sticky.test(value);
}

// A RegExp search that fails at a line terminator under a `_` retries one position later, so a wide segment
// over values with a line break every <= width characters costs value x width. No search here meets one.
function findSegment(segment: Segment, value: string, from: number, lastStart: number): number {
	const { width } = segment;
	let found: number;
	if (segment.text !== undefined) found = value.indexOf(segment.text, from);
	else if (width <= DIRECT_SEARCH_WIDTH || (!segment.lineFree && !segment.relaxed)) {
		const regExp = segment.regExp!;
		regExp.lastIndex = from;
		found = regExp.test(value) ? regExp.lastIndex - width : -1;
	} else if (segment.lineFree) return findBetweenLineTerminators(segment, value, from, lastStart);
	else return findAcrossLineTerminators(segment, value, from, lastStart);
	return found <= lastStart ? found : -1;
}

// No match holds a line terminator: search only the stretches between them.
function findBetweenLineTerminators(segment: Segment, value: string, from: number, lastStart: number): number {
	const end = lastStart + segment.width;
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

// A match can hold a line terminator, but not under a `_`. Work through windows of doubling size, so a
// match near `from` costs about the width rather than the value.
function findAcrossLineTerminators(segment: Segment, value: string, from: number, lastStart: number): number {
	const { width } = segment;
	for (let windowStart = from, size = 4 * width; windowStart <= lastStart; size *= 2) {
		const windowEnd = Math.min(lastStart + width, windowStart + size);
		const found = findInWindow(segment, value.slice(windowStart, windowEnd));
		if (found >= 0) return windowStart + found;
		windowStart = windowEnd - width + 1;
	}
	return -1;
}

function findInWindow(segment: Segment, window: string): number {
	const { width, ones } = segment;
	const lastStart = window.length - width;
	const relaxedWindow = window.includes(segment.placeholder)
		? window.replaceAll(segment.placeholder, segment.substitute)
		: window;
	const previousTerminator = previousLineTerminators(window);
	// Each relaxed match a `_` rejects can cost the width. Where those come densely, a `_` meets its line
	// terminator early, which is where the direct search fails fast, so it takes over past this budget.
	let wasted = 0;
	let start = clearOfLineTerminators(ones, previousTerminator, 0, lastStart);
	while (start <= lastStart) {
		if (wasted > RELAXED_BUDGET * window.length) return search(segment.regExp!, width, window, start, window.length);
		const found = search(segment.relaxed!, width, relaxedWindow, start, window.length);
		if (found < 0) return -1;
		start = clearOfLineTerminators(ones, previousTerminator, found, lastStart);
		if (start === found) return found;
		wasted += width;
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
