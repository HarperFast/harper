/**
 * Credential detection shared by the code that keeps credential values out of somewhere they would
 * otherwise land: the models-config hash (`resources/models/decisionStore.ts`) and the built-in agent's
 * read-only reads (`agent/tools/fsTools.ts`, `agent/registryTools.ts`).
 */

import { isUnresolvedEnvVarPlaceholder } from './expandEnvVar.ts';

/**
 * A key whose value is a credential, matched against the whole key. Anchored, unlike harper_logger's
 * CREDENTIAL_KEY_PATTERN, so settings such as `maxTokens` and `operationTokenTimeout` are not credentials.
 */
export const CREDENTIAL_KEY =
	/^(?:.*(?:secret|passw(?:or)?d|passphrase|credential).*|.*(?:key|token|cookie|authorization)|access[-_]?key[-_]?id)$/i;

const MASK = '*';
// `key: value` or `key=value` anywhere in a line, the key optionally quoted.
const ASSIGNMENT = /(?<![\w$.-])(["']?)([A-Za-z_$][\w$.-]*)\1[ \t]*([:=])[ \t]*/g;
// Indentation and YAML sequence markers before a line's first key.
const LINE_PREFIX = /^[ \t]*(?:-[ \t]+)*/;

/**
 * Where masking stands at the start of a line. `block`: the lines of a credential key's value, which in
 * YAML are every following line indented deeper than the key (blank lines included) and, when the key's
 * own line held no value, its same-column `- ` items. `unknown`: no line seen yet fixes the state.
 */
type State = { kind: 'none' } | { kind: 'unknown' } | { kind: 'block'; column: number; empty: boolean };

const NONE: State = { kind: 'none' };

/**
 * `text` with the value of every credential-named key replaced by `*`, one per UTF-16 unit, so the result
 * has the same length and line breaks as `text`. A value that is exactly a `${VAR}` placeholder is kept.
 *
 * `before` is the text that precedes `text` in its source, read only to decide whether `text` starts
 * inside a credential value. `beforeAtSourceStart` says whether it begins where the source does; if not,
 * its first line may be the cut end of a longer one.
 * Masking state is taken from the last line in it that starts in column 0 with anything but a space,
 * tab or `-`, since every YAML value ends before such a line. With no such line and no source start in
 * reach, every line is masked until one appears.
 */
export function maskCredentialValues(text: string, before = '', beforeAtSourceStart = true): string {
	const start = stateStart(text, before, beforeAtSourceStart);
	const source = start.index === before.length ? text : before.slice(start.index) + text;
	const from = before.length - start.index;
	let state: State = start.known ? NONE : { kind: 'unknown' };
	let partial = !start.known;
	const out: string[] = [];
	for (let lineStart = 0; ;) {
		const newline = source.indexOf('\n', lineStart);
		const lineEnd = newline === -1 ? source.length : newline;
		const step = maskInState(source.slice(lineStart, lineEnd), state, partial);
		state = step.state;
		partial = false;
		if (lineEnd >= from) out.push(lineStart >= from ? step.text : step.text.slice(from - lineStart));
		if (newline === -1) return out.join('\n');
		lineStart = newline + 1;
	}
}

/** Where to start reading for state: the last line start that fixes it, found by walking back through `before`. */
function stateStart(text: string, before: string, atSourceStart: boolean): { index: number; known: boolean } {
	let lineStart = before.length === 0 ? 0 : before.lastIndexOf('\n', before.length - 1) + 1;
	for (;;) {
		if (lineStart === 0) return { index: 0, known: atSourceStart };
		if (resetsState(lineStart < before.length ? before[lineStart] : text[0])) return { index: lineStart, known: true };
		lineStart = lineStart >= 2 ? before.lastIndexOf('\n', lineStart - 2) + 1 : 0;
	}
}

function resetsState(first: string | undefined): boolean {
	return first !== undefined && first !== ' ' && first !== '\t' && first !== '\r' && first !== '\n' && first !== '-';
}

function maskInState(line: string, state: State, partial: boolean): { text: string; state: State } {
	const end = line.endsWith('\r') ? line.length - 1 : line.length;
	let indent = 0;
	while (indent < end && (line[indent] === ' ' || line[indent] === '\t')) indent++;
	const blank = indent === end;
	if (state.kind === 'unknown') {
		if (partial || blank || indent > 0 || !resetsState(line[0])) {
			return { text: maskRange(line, partial ? 0 : indent, end), state };
		}
	} else if (state.kind === 'block') {
		const sequenceItem =
			line[indent] === '-' && (indent + 1 === end || line[indent + 1] === ' ' || line[indent + 1] === '\t');
		if (blank || indent > state.column || (state.empty && indent === state.column && sequenceItem)) {
			return { text: maskRange(line, indent, end), state };
		}
	}
	return maskLine(line, end);
}

/** One line on its own: every credential assignment in it, and whether it opens a block. */
function maskLine(line: string, end: number): { text: string; state: State } {
	const prefix = LINE_PREFIX.exec(line)![0].length;
	let state = NONE;
	let text = '';
	let copied = 0;
	ASSIGNMENT.lastIndex = 0;
	for (let match = ASSIGNMENT.exec(line); match && match.index < end; match = ASSIGNMENT.exec(line)) {
		if (!CREDENTIAL_KEY.test(match[2])) continue;
		const valueStart = Math.min(match.index + match[0].length, end);
		const opensBlock = match.index === prefix && match[3] === ':';
		if (opensBlock) state = { kind: 'block', column: prefix, empty: valueStart === end };
		if (valueStart === end || isPlaceholder(line.slice(valueStart, end).trimEnd())) continue;
		let maskStart = valueStart;
		let maskEnd = end;
		const quote = line[valueStart];
		if (quote === '"' || quote === "'") {
			maskStart++;
			const close = closingQuote(line, maskStart, end, quote);
			if (close !== -1) maskEnd = close;
		}
		text += line.slice(copied, maskStart) + MASK.repeat(maskEnd - maskStart);
		copied = maskEnd;
		ASSIGNMENT.lastIndex = maskEnd;
	}
	return { text: copied === 0 ? line : text + line.slice(copied), state };
}

/** The closing quote's index, or -1. `\` escapes in both quote styles and `''` in single quotes (YAML); where a style has no such escape, reading one as an escape only masks more. */
function closingQuote(line: string, from: number, end: number, quote: string): number {
	for (let index = from; index < end; index++) {
		if (line[index] === '\\') index++;
		else if (line[index] === quote) {
			if (quote === "'" && line[index + 1] === "'") index++;
			else return index;
		}
	}
	return -1;
}

function isPlaceholder(value: string): boolean {
	const quote = value[0];
	const unquoted =
		(quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote) ? value.slice(1, -1) : value;
	return isUnresolvedEnvVarPlaceholder(unquoted);
}

function maskRange(line: string, start: number, end: number): string {
	return start >= end ? line : line.slice(0, start) + MASK.repeat(end - start) + line.slice(end);
}
