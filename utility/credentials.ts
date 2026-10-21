import { isAlias, isNode, isScalar, parseAllDocuments, visit } from 'yaml';
import { isUnresolvedEnvVarPlaceholder } from './expandEnvVar.ts';

/**
 * A key whose value is a credential, matched against the whole key. Anchored, unlike harper_logger's
 * CREDENTIAL_KEY_PATTERN, so settings such as `maxTokens` and `operationTokenTimeout` are not credentials.
 */
export const CREDENTIAL_KEY =
	/^(?:.*(?:secret|passw(?:or)?d|passphrase|credential).*|.*(?:key|token|cookie|authorization)|.*access[-_]?key[-_]?id)$/i;

const MASK = '*';
// The key's quote may itself be escaped, as in JSON logged inside a JSON string. A key may follow an escape
// such as `\n`, but a match never starts past the second backslash of a run, so a run is scanned once.
const ASSIGNMENT = /(?<!(?<!\\)[\w$.-])(?<!\\\\)(\\*["']|)([A-Za-z_$][\w$.-]*)\1[ \t]*([:=])[ \t]*/g;
const LINE_PREFIX = /^[ \t]*(?:-[ \t]+)*/;

type State =
	| { kind: 'none' }
	| { kind: 'unknown' }
	| { kind: 'block'; column: number; empty: boolean }
	| { kind: 'quote'; quote: string };

const NONE: State = { kind: 'none' };

export interface MaskOptions {
	before?: string;
	beforeAtSourceStart?: boolean;
	/** The text is one log entry, so a quote left open runs to its end instead of to the next column-0 line. */
	oneEntry?: boolean;
}

/**
 * `file` with every credential value masked byte for byte, line breaks kept, so offsets into the result are
 * offsets into the file. A file is parsed as YAML, which finds the keys a text scan cannot (an escaped key,
 * an anchor a credential key aliases), and also scanned as text, which finds `KEY=value` lines a YAML parse
 * reads as one string. Undefined when the bytes are not UTF-8, so offsets cannot be mapped.
 */
export function maskCredentialFile(file: Buffer): Buffer | undefined {
	const text = file.toString('utf8');
	if (!Buffer.from(text, 'utf8').equals(file)) return undefined;
	const masked = new Uint8Array(text.length);
	for (const [start, end] of yamlCredentialRanges(text)) masked.fill(1, start, end);
	const scanned = maskCredentialValues(text);
	for (let index = 0; index < text.length; index++) if (scanned[index] !== text[index]) masked[index] = 1;
	const out = Buffer.from(file);
	let indenting = true;
	for (let unit = 0, byte = 0; unit < text.length;) {
		const point = text.codePointAt(unit)!;
		const units = point > 0xffff ? 2 : 1;
		const bytes = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
		const lineBreak = point === 0x0a || point === 0x0d;
		indenting = lineBreak || (indenting && (point === 0x20 || point === 0x09));
		if ((masked[unit] || masked[unit + units - 1]) && !lineBreak && !indenting) out.fill(MASK, byte, byte + bytes);
		unit += units;
		byte += bytes;
	}
	return out;
}

/** Source ranges of the values of credential keys, as YAML resolves the keys, and of the anchors they alias. */
function yamlCredentialRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const document of parseAllDocuments(text)) {
		visit(document, {
			Pair(_, pair) {
				const key = isScalar(pair.key) ? pair.key.value : undefined;
				if (typeof key !== 'string' || !CREDENTIAL_KEY.test(key) || !isNode(pair.value)) return;
				const target = isAlias(pair.value) ? pair.value.resolve(document) : pair.value;
				if (isScalar(target) && isUnresolvedEnvVarPlaceholder(target.value)) return;
				for (const node of [pair.value, target]) if (node?.range) ranges.push([node.range[0], node.range[1]]);
			},
		});
	}
	return ranges;
}

/** `text` with the value of every credential-named key replaced by `*`, one per UTF-16 unit. */
export function maskCredentialValues(text: string, options: MaskOptions = {}): string {
	const { before = '', beforeAtSourceStart = true, oneEntry = false } = options;
	const start = stateStart(text, before, beforeAtSourceStart);
	const source = start.index === before.length ? text : before.slice(start.index) + text;
	const from = before.length - start.index;
	let state: State = start.known ? NONE : { kind: 'unknown' };
	let partial = !start.known;
	const out: string[] = [];
	for (let lineStart = 0; ;) {
		const newline = source.indexOf('\n', lineStart);
		const lineEnd = newline === -1 ? source.length : newline;
		const step = maskInState(source.slice(lineStart, lineEnd), state, partial, oneEntry);
		state = step.state;
		partial = false;
		if (lineEnd >= from) out.push(lineStart >= from ? step.text : step.text.slice(from - lineStart));
		if (newline === -1) return out.join('\n');
		lineStart = newline + 1;
	}
}

function stateStart(text: string, before: string, atSourceStart: boolean): { index: number; known: boolean } {
	let lineStart = before.length === 0 ? 0 : before.lastIndexOf('\n', before.length - 1) + 1;
	for (;;) {
		if (lineStart === 0) return { index: 0, known: atSourceStart };
		if (resetsState(lineStart < before.length ? before[lineStart] : text[0])) return { index: lineStart, known: true };
		lineStart = lineStart >= 2 ? before.lastIndexOf('\n', lineStart - 2) + 1 : 0;
	}
}

// Every YAML value ends before a line that starts in column 0 with anything but a space, tab, `-` or a
// comment, which YAML exempts from indentation.
function resetsState(first: string | undefined): boolean {
	return (
		first !== undefined &&
		first !== ' ' &&
		first !== '\t' &&
		first !== '\r' &&
		first !== '\n' &&
		first !== '-' &&
		first !== '#'
	);
}

function maskInState(line: string, state: State, partial: boolean, oneEntry: boolean): { text: string; state: State } {
	const end = line.endsWith('\r') ? line.length - 1 : line.length;
	let indent = 0;
	while (indent < end && (line[indent] === ' ' || line[indent] === '\t')) indent++;
	const resets = !partial && indent === 0 && indent < end && resetsState(line[0]);
	if (state.kind === 'unknown' && !resets) {
		return { text: maskRange(line, partial ? 0 : indent, end), state };
	}
	if (state.kind === 'quote' && (oneEntry || !resets)) {
		const close = closingQuote(line, indent, end, state.quote);
		if (close === -1) return { text: maskRange(line, indent, end), state };
		const rest = maskLine(line, end, close + 1);
		return { text: maskRange(rest.text, indent, close), state: rest.state };
	}
	if (state.kind === 'block') {
		const sequenceItem =
			line[indent] === '-' && (indent + 1 === end || line[indent + 1] === ' ' || line[indent + 1] === '\t');
		if (indent === end || indent > state.column || (state.empty && indent === state.column && sequenceItem)) {
			return { text: maskRange(line, indent, end), state };
		}
		if (line[indent] === '#') return { text: line, state };
	}
	return maskLine(line, end, 0);
}

function maskLine(line: string, end: number, from: number): { text: string; state: State } {
	const prefix = LINE_PREFIX.exec(line)![0].length;
	let state = NONE;
	let text = '';
	let copied = 0;
	ASSIGNMENT.lastIndex = from;
	for (let match = ASSIGNMENT.exec(line); match && match.index < end; match = ASSIGNMENT.exec(line)) {
		if (!CREDENTIAL_KEY.test(match[2])) continue;
		const valueStart = Math.min(match.index + match[0].length, end);
		// A YAML comment after the key leaves its value empty, so the key's `- ` items below are its value.
		const comment = line[valueStart] === '#' && /[ \t]/.test(line[valueStart - 1]);
		if (match.index === prefix && match[3] === ':') {
			state = { kind: 'block', column: prefix, empty: valueStart === end || comment };
		}
		if (valueStart === end || isPlaceholder(line.slice(valueStart, end).trimEnd())) continue;
		let escapes = 0;
		while (line[valueStart + escapes] === '\\') escapes++;
		const quote = line[valueStart + escapes];
		let maskStart = valueStart;
		let maskEnd = end;
		if (quote === '"' || quote === "'") {
			maskStart += escapes + 1;
			const close =
				escapes === 0
					? closingQuote(line, maskStart, end, quote)
					: escapes === 1
						? closingEscapedQuote(line, maskStart, end, quote)
						: -1;
			if (close !== -1) maskEnd = close;
			else if (escapes === 0) state = { kind: 'quote', quote };
		}
		text += line.slice(copied, maskStart) + MASK.repeat(maskEnd - maskStart);
		copied = maskEnd;
		ASSIGNMENT.lastIndex = maskEnd;
	}
	return { text: copied === 0 ? line : text + line.slice(copied), state };
}

/**
 * The closing quote's index, `end` to mask the rest of the line, or -1 when the quote stays open. In single
 * quotes `''` is YAML's escape, and `\'` is one in inspected JavaScript but not in YAML, so it masks to the end.
 */
function closingQuote(line: string, from: number, end: number, quote: string): number {
	for (let index = from; index < end; index++) {
		if (line[index] === '\\') {
			if (quote === "'" && line[index + 1] === "'") return end;
			index++;
		} else if (line[index] === quote) {
			if (quote === "'" && line[index + 1] === "'") index++;
			else return index;
		}
	}
	return -1;
}

/**
 * Where a string quoted by `\<quote>` closes, or -1: the line's escapes are decoded first, then the string's
 * own, so a quote escaped inside the inner string (`\\\"`) does not close it. Deeper nesting masks to the end
 * of the line instead.
 */
function closingEscapedQuote(line: string, from: number, end: number, quote: string): number {
	let innerEscape = false;
	for (let index = from; index < end;) {
		const at = index;
		const escaped = line[index] === '\\' && index + 1 < end;
		const decoded = escaped ? line[index + 1] : line[index];
		index += escaped ? 2 : 1;
		if (innerEscape) innerEscape = false;
		else if (decoded === '\\') innerEscape = true;
		else if (decoded === quote && escaped) return at;
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
