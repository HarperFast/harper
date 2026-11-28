/**
 * Legacy SQL authorizes the parsed statement but runs the statement's `toString()` text, parsed again, so that
 * text must keep every literal a literal and every name one name. The AST's writers (parser/sqlText.ts) spell
 * literals so they read back as the same value; this module refuses what they cannot spell.
 */
import { backtickASTSchemaItems } from '../utility/common_utils.ts';
import * as sqlAst from './parser/ast.ts';
import { parse } from './parser/parser.ts';
import { isJsonData, jsonText, quoteString, unwritable } from './parser/sqlText.ts';
import { astNodes } from './sql_statement_bucket.ts';

export { generatedName, quoteString } from './parser/sqlText.ts';

const yy = sqlAst;

// Harper writes names inside backticks, and the AST inside brackets; neither can escape these.
const UNQUOTABLE_NAME = /[`[\]']/;
// `@variable`, `$param` and the name after `->` or `!` are written with no quoting at all.
const BARE_NAME = /^\w+$/;

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
		statements = parse(text).statements;
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
