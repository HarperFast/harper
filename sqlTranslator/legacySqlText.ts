/**
 * Legacy SQL authorizes the parsed statement but runs AlaSQL's re-parse of its `toString()` text, so that text
 * must keep every literal a literal and every name one name. AlaSQL writes string and JSON literals without
 * escaping, and numbers in a form it reads back as a column.
 */
import alasql from 'alasql';
import { backtickASTSchemaItems } from '../utility/common_utils.ts';
import { ClientError } from '../utility/errors/hdbError.ts';
import { astNodes } from './sql_statement_bucket.ts';

const yy = (alasql as any).yy;

// Harper writes names inside backticks, and AlaSQL inside brackets; neither can escape these.
const UNQUOTABLE_NAME = /[`[\]']/;
// AlaSQL writes `@variable`, `$param` and the name after `->` or `!` with no quoting at all.
const BARE_NAME = /^\w+$/;

/**
 * Single-quoted text that AlaSQL decodes back to `value`, or undefined when there is none. AlaSQL lexes a
 * backslash as taking the next character, then decodes `\'` and `''` to `'`, so an odd run of backslashes at
 * the end has no spelling.
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
			if (backslashes % 2) text += '\\'.repeat(backslashes + 1) + "''";
			else text += '\\'.repeat(backslashes) + (backslashes ? "\\'" : "''");
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

// AlaSQL reads `1e+25` as `1e + 25` and `Infinity` as a column, so write every number in plain decimal.
function numberText(value: number): string {
	if (!Number.isFinite(value)) throw unwritable(`The number ${value}`);
	const text = String(value);
	const e = text.indexOf('e');
	if (e < 0) return text;
	const sign = text[0] === '-' ? '-' : '';
	const [whole, fraction = ''] = text.slice(sign.length, e).split('.');
	const digits = whole + fraction;
	const point = whole.length + Number(text.slice(e + 1));
	if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
	if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** A generated result name AlaSQL reads as one name: in brackets, or in double quotes when it holds `]`. */
export function generatedName(name: string): string {
	if (!name.includes(']')) return `[${name}]`;
	if (!name.includes('"')) return `"${name}"`;
	throw unwritable(`The name ${JSON.stringify(name)}`);
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
	if (typeof value === 'number') return numberText(value);
	if (typeof value !== 'object') return String(value);
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
	yy.NumValue.prototype.toString = function () {
		return typeof this.value === 'number' ? numberText(this.value) : String(this.value);
	};
}

const NAME_KEYS = ['databaseid', 'tableid', 'columnid', 'funcid', 'aggregatorid', 'variable', 'param'];

// A column counts together with its table and database, as one reference.
function referenceCounts(statement: any): Map<string, number> {
	const counts = new Map<string, number>();
	for (const node of statementNodes(statement)) {
		const parts = node instanceof yy.JavaScript ? [`javascript=${node.value}`] : [];
		for (const key of NAME_KEYS) {
			if (!Object.hasOwn(node, key)) continue;
			// `?` is param 0, written back as `$0`.
			let name = typeof node[key] === 'number' ? String(node[key]) : node[key];
			if (typeof name !== 'string') continue;
			if (name.length > 1 && name.startsWith('`') && name.endsWith('`')) name = name.slice(1, -1);
			// AlaSQL writes function names upper-cased.
			parts.push(`${key}=${key === 'funcid' || key === 'aggregatorid' ? name.toUpperCase() : name}`);
		}
		if (parts.length === 0) continue;
		const reference = parts.join('\u0000');
		counts.set(reference, (counts.get(reference) ?? 0) + 1);
	}
	return counts;
}

// Skips the plain objects and arrays that are a JSON literal's data.
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

/** Throws a 400 for a statement whose SQL text, as legacy SQL runs it, would not parse back to what it reads. */
export function assertLegacySqlText(statement: any) {
	if (statement instanceof yy.Insert) {
		// INSERT takes literal values as data, and runs each other value as `SELECT <value> AS [...] FROM ?`.
		for (const row of statement.values ?? []) {
			for (const value of row) {
				if ('value' in value) continue;
				assertWritableNodes(value);
				const authorized = referenceCounts(value);
				authorized.set('param=0', (authorized.get('param=0') ?? 0) + 1);
				assertReparse(`SELECT ${value} AS [v] FROM ?`, authorized);
			}
		}
		return;
	}
	assertWritableNodes(statement);
	// SQLSearch names an unaliased function column `[<its text>]` when the statement reads a table.
	for (const column of statement instanceof yy.Select && statement.from?.length ? statement.columns : []) {
		if (column.funcid && column.args && !column.aggregatorid && !column.as && column.toString().includes(']')) {
			throw unwritable('A function column holding `]` without an alias');
		}
	}
	const authorized = referenceCounts(statement);
	assertReparse(legacyText(statement), authorized);
}

function assertWritableNodes(root: any) {
	for (const node of statementNodes(root)) {
		if (node instanceof yy.StringValue && quoteString(String(node.value)) === undefined) {
			throw unwritable('A string literal');
		}
		if (node instanceof yy.Json) jsonText(node.value);
		const bareKeys = node instanceof yy.Op && (node.op === '->' || node.op === '!') ? ['right'] : ['variable', 'param'];
		for (const key of bareKeys) {
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

// Catches any writer not replaced here: the text legacy runs may read nothing the statement does not.
function assertReparse(text: string, authorized: Map<string, number>) {
	let statements: any[];
	try {
		statements = (alasql as any).parse(text).statements;
	} catch {
		throw unwritable('The statement');
	}
	if (statements.length !== 1) throw unwritable('The statement');
	for (const [reference, count] of referenceCounts(statements[0])) {
		if (count > (authorized.get(reference) ?? 0)) throw unwritable('The statement');
	}
}

const BACKTICKED_KEYS = ['columnid', 'tableid', 'databaseid', 'as'];

// The statement's text with Harper's backticks, leaving the statement as it was.
function legacyText(statement: any): string {
	const columns = statement.columns;
	// `SELECT *` for a role that may read no column leaves no columns, which does not parse.
	const placeholder = statement instanceof yy.Select && columns?.length === 0;
	if (placeholder) statement.columns = [new yy.NumValue({ value: 1 })];
	// backtickASTSchemaItems rewrites these keys on every object it reaches, JSON literal data included.
	const saved = [];
	for (const node of astNodes(statement)) {
		for (const key of BACKTICKED_KEYS) {
			if (!Object.hasOwn(node, key)) continue;
			const orig = `${key}_orig`;
			saved.push({ node, key, value: node[key], hadOrig: Object.hasOwn(node, orig), origValue: node[orig] });
		}
	}
	backtickASTSchemaItems(statement);
	try {
		return statement.toString();
	} finally {
		for (const { node, key, value, hadOrig, origValue } of saved) {
			node[key] = value;
			if (hadOrig) node[`${key}_orig`] = origValue;
			else delete node[`${key}_orig`];
		}
		if (placeholder) statement.columns = columns;
	}
}
