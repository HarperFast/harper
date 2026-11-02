// Leftmost placement of each middle segment is always safe: any match that places it further right still
// matches with it shifted left, so no position is revisited.

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

interface Chunk {
	offset: number;
	width: number;
	source: string;
	sticky: RegExp;
}

interface Segment {
	width: number;
	/** Literal text, matched with `startsWith`/`indexOf` when the comparison is case-sensitive. */
	text: string | undefined;
	chunks: Chunk[];
	/** Global search for the first chunk; only middle segments search. */
	search: RegExp | undefined;
}

// Segment RegExps hold no quantifier or alternation, so they cannot backtrack. V8 fails to compile one of about
// 50k atoms, and only on its first match, so a longer segment is split into chunks matched at fixed offsets.
const MAX_CHUNK_WIDTH = 10_000;
const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|/-]/;

export function compileLikeTokens(tokens: LikeToken[], options: LikeMatchOptions = {}): LikeMatcher {
	const flags = options.caseInsensitive ? 'i' : '';
	const one = options.oneExcludesLineTerminators ? '.' : '[\\s\\S]';
	const segments: Segment[] = [];
	let text: string | undefined = '';
	let units: string[] = [];
	const endSegment = () => {
		const literal = text !== undefined && (!flags || units.length === 0);
		const chunks: Chunk[] = [];
		if (!literal) {
			for (let offset = 0; offset < units.length; offset += MAX_CHUNK_WIDTH) {
				const source = units.slice(offset, offset + MAX_CHUNK_WIDTH).join('');
				const width = Math.min(MAX_CHUNK_WIDTH, units.length - offset);
				chunks.push({ offset, width, source, sticky: new RegExp(source, flags + 'y') });
			}
		}
		segments.push({ width: units.length, text: literal ? text : undefined, chunks, search: undefined });
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
			units.push(token.kind === 'one' ? one : token.source);
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
	for (const segment of middle) {
		if (segment.text === undefined) segment.search = new RegExp(segment.chunks[0].source, flags + 'g');
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

function segmentMatchesAt(segment: Segment, value: string, start: number, fromChunk = 0): boolean {
	if (segment.text !== undefined) return value.startsWith(segment.text, start);
	const chunks = segment.chunks;
	for (let i = fromChunk; i < chunks.length; i++) {
		const chunk = chunks[i];
		chunk.sticky.lastIndex = start + chunk.offset;
		if (!chunk.sticky.test(value)) return false;
	}
	return true;
}

function findSegment(segment: Segment, value: string, from: number, lastStart: number): number {
	if (segment.text !== undefined) {
		const found = value.indexOf(segment.text, from);
		return found <= lastStart ? found : -1;
	}
	const search = segment.search!;
	const firstWidth = segment.chunks[0].width;
	search.lastIndex = from;
	while (search.test(value)) {
		const start = search.lastIndex - firstWidth;
		if (start > lastStart) return -1;
		if (segmentMatchesAt(segment, value, start, 1)) return start;
		search.lastIndex = start + 1;
	}
	return -1;
}
