/**
 * Legacy SQL authorizes the parsed statement but runs AlaSQL's re-parse of its `toString()` text, so that text
 * must keep every literal a literal and every name one name. AlaSQL writes string and JSON literals without
 * escaping.
 */
import alasql from 'alasql';
import { ClientError } from '../utility/errors/hdbError.ts';
import { astNodes } from './sql_statement_bucket.ts';

const yy = (alasql as any).yy;

// Harper writes names inside backticks, and AlaSQL inside brackets; neither can escape these.
const UNQUOTABLE_NAME = /[`[\]']/;
// AlaSQL writes `@variable` and `$param` with no quoting at all.
const BARE_NAME = /^\w+$/;

/**
 * Single-quoted text that AlaSQL decodes back to `value`, or undefined when there is none. AlaSQL lexes a
 * backslash as taking the next character, then decodes `\'` and `''` to `'`, so a quote after an even run of
 * backslashes, or an odd run at the end, has no spelling.
 */
export function quoteString(value: string): string | undefined {
	let text = "'";
	let i = 0;
	while (i < value.length) {
		let backslashes = 0;
		while (value[i + backslashes] === '\\') backslashes++;
		const next = value[i + backslashes];
		if (next === undefined) {
			if (backslashes % 2) return undefined;
			text += value.slice(i);
			break;
		}
		if (next === "'") {
			if (backslashes === 0) text += "''";
			else if (backslashes % 2) text += '\\'.repeat(backslashes + 1) + "''";
			else return undefined;
		} else {
			text += value.slice(i, i + backslashes + 1);
		}
		i += backslashes + 1;
	}
	return text + "'";
}

// A JSON key is the token body undecoded, so it must lex as it stands inside one of the quotes.
function quoteKey(key: string): string | undefined {
	if (lexesInside(key, '"')) return `"${key}"`;
	if (lexesInside(key, "'")) return `'${key}'`;
}

function lexesInside(body: string, quote: string): boolean {
	for (let i = 0; i < body.length; i++) {
		if (body[i] === '\\') {
			if (++i >= body.length) return false;
		} else if (body[i] === quote && body[++i] !== quote) {
			return false;
		}
	}
	return true;
}

function unwritable(what: string) {
	return new ClientError(
		`${what} cannot be written back to SQL text for the legacy SQL engine. Remove the quotes, backticks, brackets or backslashes, or use the new SQL engine.`
	);
}

function isJsonData(value: any): boolean {
	return Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
}

function jsonText(value: any): string {
	if (typeof value === 'string') {
		const text = quoteString(value);
		if (text === undefined) throw unwritable('A string in a JSON literal');
		return text;
	}
	if (value == null) return 'NULL';
	if (typeof value !== 'object') return typeof value === 'bigint' ? `${value}n` : String(value);
	// Any other object is an AST node inside the literal, a nested JSON literal included.
	if (!isJsonData(value)) return value.toString();
	if (Array.isArray(value)) return `@[${value.map(jsonText).join(',')}]`;
	const properties = [];
	for (const key in value) {
		const keyText = quoteKey(key);
		if (keyText === undefined) throw unwritable('A key in a JSON literal');
		properties.push(`${keyText}:${jsonText(value[key])}`);
	}
	return `{${properties.join(',')}}`;
}

export function installLegacySqlText() {
	yy.StringValue.prototype.toString = function () {
		const text = quoteString(String(this.value));
		if (text === undefined) throw unwritable('A string literal');
		return text;
	};
	yy.Json.prototype.toString = function () {
		return jsonText(this.value);
	};
}

// AST nodes, without the plain objects and arrays that are a JSON literal's data.
function* statementNodes(statement: any): Generator<any> {
	const literalData = new Set();
	for (const node of astNodes(statement)) {
		if (literalData.has(node)) continue;
		yield node;
		if (!(node instanceof yy.Json)) continue;
		const pending = [node.value];
		while (pending.length > 0) {
			const value = pending.pop();
			if (value === null || typeof value !== 'object' || literalData.has(value) || !isJsonData(value)) continue;
			literalData.add(value);
			for (const child of Object.values(value)) pending.push(child);
		}
	}
}

/** Throws a 400 for a statement whose SQL text would not parse back to what it reads. */
export function assertLegacySqlText(statement: any) {
	for (const node of statementNodes(statement)) {
		if (node instanceof yy.StringValue && quoteString(String(node.value)) === undefined) {
			throw unwritable('A string literal');
		}
		if (node instanceof yy.Json) jsonText(node.value);
		for (const key of ['variable', 'param']) {
			const value = node[key];
			if (Object.hasOwn(node, key) && typeof value === 'string' && !BARE_NAME.test(value)) {
				throw unwritable(`The name ${JSON.stringify(value)}`);
			}
		}
		for (const key in node) {
			const value = node[key];
			if (
				Object.hasOwn(node, key) &&
				typeof value === 'string' &&
				UNQUOTABLE_NAME.test(value) &&
				!(key === 'value' && (node instanceof yy.StringValue || node instanceof yy.JavaScript))
			) {
				throw unwritable(`The name ${JSON.stringify(value)}`);
			}
		}
	}
}
