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
	wildcard: boolean;
	text: string | undefined;
	regExp: RegExp | undefined;
	// No unit matches a line terminator, so no match contains one.
	lineFree: boolean;
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|/-]/;
const LINE_TERMINATORS = ['\n', '\r', '\u2028', '\u2029'];
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;
// A search retrying every start costs at most the width per start; up to this width that is cheaper than
// stopping at each line terminator (~100 ns each on V8).
const DIRECT_SEARCH_WIDTH = 64;
// Under `i`, V8 compiles each `[^]` in about 0.05 ms, and `[^X]` for a single X in a fraction of that.
const PLACEHOLDER_ONES = 64;
// Noncharacters: no case mapping reaches them.
const PLACEHOLDERS = ['\uffff', '\ufffe'];
for (let code = 0xfdd0; code <= 0xfdef; code++) PLACEHOLDERS.push(String.fromCharCode(code));

// Segment RegExps hold no quantifier or alternation, so they cannot backtrack. A fixed count is no exception:
// `[^]{9998}` searches about 3,000x slower than the same atoms written out.
export function compileLikeTokens(tokens: LikeToken[], caseInsensitive = false): LikeMatcher {
	const flags = caseInsensitive ? 'i' : '';
	const segmentTokens: Exclude<LikeToken, { kind: 'any' }>[][] = [[]];
	for (const token of tokens) {
		if (token.kind === 'any') segmentTokens.push([]);
		else segmentTokens.at(-1)!.push(token);
	}
	const classes = new Map<string, RegExp>();
	const literals = new Set<string>();
	let ones = 0;
	for (const units of segmentTokens) {
		if (units.every((token) => token.kind === 'one')) continue;
		for (const token of units) {
			if (token.kind === 'class') classes.set(token.source, new RegExp(token.source, flags));
			else if (token.kind === 'literal') literals.add(token.char);
			else ones++;
		}
	}
	// `_` is any one code unit. Under `i`, many `[^]` compile slowly, so `_` becomes `[^placeholder]` over a
	// value with each placeholder replaced by the substitute, a pair no literal is and every class treats alike.
	const pair = flags && ones > PLACEHOLDER_ONES ? placeholderPair(literals, [...classes.values()]) : undefined;
	const [placeholder, substitute] = pair ?? ['', ''];
	const one = placeholder ? `[^\\u${placeholder.charCodeAt(0).toString(16)}]` : '[^]';

	const segments: Segment[] = segmentTokens.map((units, index) => {
		let text: string | undefined = '';
		let lineFree = true;
		let source = '';
		for (const token of units) {
			if (token.kind === 'literal') {
				if (text !== undefined) text += token.char;
				if (LINE_TERMINATORS.includes(token.char)) lineFree = false;
				source += token.char.replace(REGEXP_SYNTAX, '\\$&');
			} else {
				text = undefined;
				if (token.kind === 'one') {
					lineFree = false;
					source += one;
				} else {
					const unit = classes.get(token.source)!;
					if (LINE_TERMINATORS.some((terminator) => unit.test(terminator))) lineFree = false;
					source += token.source;
				}
			}
		}
		const wildcard = units.length > 0 && units.every((token) => token.kind === 'one');
		const literal = text !== undefined && (!flags || units.length === 0);
		return {
			width: units.length,
			wildcard,
			text: literal ? text : undefined,
			regExp:
				wildcard || literal
					? undefined
					: new RegExp(source, flags + (index === 0 || index === segmentTokens.length - 1 ? 'y' : 'g')),
			lineFree,
		};
	});

	const first = segments[0];
	const last = segments[segments.length - 1];
	const middle = segments.slice(1, -1).filter((segment) => segment.width > 0);
	if (segments.length === 1) {
		return (value) => value.length === first.width && segmentMatchesAt(first, value, 0, placeholder, substitute);
	}
	return (value) => {
		const end = value.length - last.width;
		if (
			end < first.width ||
			!segmentMatchesAt(first, value, 0, placeholder, substitute) ||
			!segmentMatchesAt(last, value, end, placeholder, substitute)
		) {
			return false;
		}
		if (middle.length === 0) return true;
		const subject = substitutePlaceholder(value, placeholder, substitute);
		let position = first.width;
		for (const segment of middle) {
			const found = findSegment(segment, subject, position, end - segment.width);
			if (found < 0) return false;
			position = found + segment.width;
		}
		return true;
	};
}

function substitutePlaceholder(value: string, placeholder: string, substitute: string): string {
	return placeholder && value.includes(placeholder) ? value.replaceAll(placeholder, substitute) : value;
}

function placeholderPair(literals: Set<string>, classes: RegExp[]): [string, string] | undefined {
	const usable = PLACEHOLDERS.filter((placeholder) => !literals.has(placeholder));
	for (let i = 0; i < usable.length; i++) {
		for (let j = i + 1; j < usable.length; j++) {
			if (classes.every((unit) => unit.test(usable[i]) === unit.test(usable[j]))) return [usable[i], usable[j]];
		}
	}
	return undefined;
}

// Substitutes only the units the segment covers, so a row the anchors reject costs no pass over the value.
function segmentMatchesAt(
	segment: Segment,
	value: string,
	start: number,
	placeholder: string,
	substitute: string
): boolean {
	if (segment.wildcard) return true;
	if (segment.text !== undefined) return value.startsWith(segment.text, start);
	const sticky = segment.regExp!;
	if (placeholder) {
		value = substitutePlaceholder(value.slice(start, start + segment.width), placeholder, substitute);
		start = 0;
	}
	sticky.lastIndex = start;
	return sticky.test(value);
}

function findSegment(segment: Segment, value: string, from: number, lastStart: number): number {
	const { width } = segment;
	let found: number;
	if (segment.wildcard) found = from;
	else if (segment.text !== undefined) found = value.indexOf(segment.text, from);
	else if (segment.lineFree && width > DIRECT_SEARCH_WIDTH) {
		return findBetweenLineTerminators(segment, value, from, lastStart);
	} else {
		const regExp = segment.regExp!;
		regExp.lastIndex = from;
		found = regExp.test(value) ? regExp.lastIndex - width : -1;
	}
	return found <= lastStart ? found : -1;
}

// A RegExp search that fails at a line terminator retries one position later, so a wide segment over values
// with a line break every <= width characters would cost value x width. No match of a line-free segment holds
// one: search only the stretches between them. Look for the next one in windows of doubling size, so a match
// near `from` costs about the width rather than the value.
function findBetweenLineTerminators(segment: Segment, value: string, from: number, lastStart: number): number {
	const { width } = segment;
	const end = lastStart + width;
	for (let start = from, size = 4 * width; start <= lastStart;) {
		const scanEnd = Math.min(end, start + size);
		LINE_TERMINATOR.lastIndex = 0;
		const lineEnd = LINE_TERMINATOR.test(value.slice(start, scanEnd)) ? start + LINE_TERMINATOR.lastIndex - 1 : -1;
		const found = search(segment.regExp!, width, value, start, lineEnd < 0 ? scanEnd : lineEnd);
		if (found >= 0) return found;
		if (lineEnd >= 0) start = lineEnd + 1;
		else if (scanEnd === end) return -1;
		else {
			start = scanEnd - width + 1;
			size *= 2;
		}
	}
	return -1;
}

// Finds the leftmost match that ends by `end`, without examining any character at or after it.
function search(regExp: RegExp, width: number, value: string, from: number, end: number): number {
	if (end - from < width) return -1;
	regExp.lastIndex = 0;
	return regExp.test(value.slice(from, end)) ? from + regExp.lastIndex - width : -1;
}
