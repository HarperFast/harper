/**
 * Binder.
 *
 * Resolves the table references in a SelectNode to concrete Table classes via
 * core/resources/databases.ts.
 *
 * Single-table SELECT (phase 1-2): fills `boundTable` with primaryKey +
 * attribute names so downstream rules can validate columns. Column references
 * keep their bare names and rows flow through the pipeline keyed by bare
 * attribute name.
 *
 * Multi-table SELECT (phase 3, joins): additionally binds every joined table
 * into an ordered `scope`, and resolves every column reference to the canonical
 * alias of its owning table (mutating `column.table` in place). Ambiguous or
 * unknown qualified references throw EngineUnsupportedError. Join rows flow
 * through the pipeline keyed by `<alias>.<attribute>` (see expressions/compile
 * `qualified` mode and physical/PhysicalQualify).
 */

import type { ExprNode, SelectNode, StatementNode, TableRefNode } from '../parser/ast.ts';
import { EngineUnsupportedError } from '../errors.ts';

interface AttributeInfo {
	name: string;
	indexed: boolean;
	isPrimaryKey: boolean;
}

export interface BoundTable {
	database: string;
	table: string;
	alias?: string;
	/** alias ?? table — the name columns are qualified by in join queries. */
	effectiveAlias: string;
	primaryKey?: string;
	attributes: AttributeInfo[];
	resource: unknown;
}

export interface BoundSelect extends SelectNode {
	boundTable: BoundTable;
	/** FROM table plus every joined table, in declaration order. */
	scope: BoundTable[];
	/** true once joins are present and columns have been qualified. */
	qualified: boolean;
}

export interface BindContext {
	user?: unknown;
}

let _databasesLoader: (() => Record<string, Record<string, unknown>>) | null = null;

/**
 * Override hook for tests. Restored to default by passing null.
 */
export function _setDatabasesLoader(loader: typeof _databasesLoader): void {
	_databasesLoader = loader;
}

function loadDatabases(): Record<string, Record<string, unknown>> {
	if (_databasesLoader) return _databasesLoader();
	const mod = require('../../resources/databases.js');
	return mod.getDatabases();
}

export function bind(stmt: StatementNode, _ctx: BindContext): StatementNode {
	if (stmt.kind !== 'select') {
		throw new EngineUnsupportedError(`bind: only SELECT supported, got ${stmt.kind}`);
	}
	return bindSelect(stmt);
}

export function bindSelect(stmt: SelectNode): BoundSelect {
	const databases = loadDatabases();

	const fromTable = bindTableRef(stmt.from, databases);
	const scope: BoundTable[] = [fromTable];
	for (const join of stmt.joins) {
		scope.push(bindTableRef(join.table, databases));
	}

	const qualified = stmt.joins.length > 0;

	if (qualified) {
		// Resolve every column reference to a canonical alias, in place.
		resolveColumnsInSelect(stmt, scope);
	}

	return {
		...stmt,
		from: { ...stmt.from, database: fromTable.database },
		boundTable: fromTable,
		scope,
		qualified,
	};
}

function bindTableRef(ref: TableRefNode, databases: Record<string, Record<string, unknown>>): BoundTable {
	const databaseName = ref.database || pickDefaultDatabase(databases, ref.table);
	const dbEntry = databases[databaseName];
	if (!dbEntry) {
		throw new EngineUnsupportedError(`database "${databaseName}" not found`);
	}
	const resource = dbEntry[ref.table];
	if (!resource) {
		throw new EngineUnsupportedError(`table "${databaseName}.${ref.table}" not found`);
	}
	const r = resource as {
		primaryKey?: string;
		attributes?: { name: string; indexed?: boolean }[];
		indices?: Record<string, unknown>;
	};
	const primaryKey = r.primaryKey;
	const indices = r.indices ?? {};
	const attributes: AttributeInfo[] = (r.attributes ?? []).map((a) => ({
		name: a.name,
		indexed: !!a.indexed || !!indices[a.name] || a.name === primaryKey,
		isPrimaryKey: a.name === primaryKey,
	}));

	return {
		database: databaseName,
		table: ref.table,
		alias: ref.alias,
		effectiveAlias: ref.alias ?? ref.table,
		primaryKey,
		attributes,
		resource,
	};
}

function pickDefaultDatabase(databases: Record<string, Record<string, unknown>>, tableName: string): string {
	const matches: string[] = [];
	for (const dbName of Object.keys(databases)) {
		if (databases[dbName]?.[tableName]) matches.push(dbName);
	}
	if (matches.length === 0) {
		throw new EngineUnsupportedError(`table "${tableName}" not found in any database`);
	}
	if (matches.length > 1) {
		throw new EngineUnsupportedError(
			`table "${tableName}" exists in multiple databases (${matches.join(', ')}); qualify the schema`
		);
	}
	return matches[0];
}

// ---------------------------------------------------------------------------
// Column resolution for join queries
// ---------------------------------------------------------------------------

function resolveColumnsInSelect(stmt: SelectNode, scope: BoundTable[]): void {
	for (const p of stmt.projections) resolveColumns(p.expr, scope);
	for (const j of stmt.joins) {
		if (j.on) resolveColumns(j.on, scope);
	}
	if (stmt.where) resolveColumns(stmt.where, scope);
	if (stmt.groupBy) for (const g of stmt.groupBy) resolveColumns(g, scope);
	if (stmt.having) resolveColumns(stmt.having, scope);
	if (stmt.orderBy) for (const o of stmt.orderBy) resolveColumns(o.expr, scope);
}

/** Resolves a qualifier string (alias or table name) to the canonical alias. */
function resolveQualifier(qualifier: string, scope: BoundTable[]): BoundTable | undefined {
	return (
		scope.find((t) => t.effectiveAlias === qualifier) ??
		scope.find((t) => t.table === qualifier) ??
		scope.find((t) => t.alias === qualifier)
	);
}

function resolveColumns(expr: ExprNode, scope: BoundTable[]): void {
	switch (expr.kind) {
		case 'column': {
			if (expr.table) {
				const t = resolveQualifier(expr.table, scope);
				if (!t) {
					throw new EngineUnsupportedError(`unknown table qualifier "${expr.table}" for column "${expr.name}"`);
				}
				expr.table = t.effectiveAlias;
				return;
			}
			// Unqualified: bind to the unique table that declares this attribute.
			const owners = scope.filter((t) => t.attributes.some((a) => a.name === expr.name));
			if (owners.length === 1) {
				expr.table = owners[0].effectiveAlias;
			} else if (owners.length > 1) {
				throw new EngineUnsupportedError(
					`column "${expr.name}" is ambiguous across ${owners.map((o) => o.effectiveAlias).join(', ')}; qualify it`
				);
			} else {
				// Not declared on any table (undeclared attribute) — default to FROM table.
				expr.table = scope[0].effectiveAlias;
			}
			return;
		}
		case 'star':
			// `t.*` qualifier is validated at star-expansion time; bare `*` spans all.
			if (expr.table) {
				const t = resolveQualifier(expr.table, scope);
				if (!t) throw new EngineUnsupportedError(`unknown table qualifier "${expr.table}" in "${expr.table}.*"`);
				expr.table = t.effectiveAlias;
			}
			return;
		case 'binop':
			resolveColumns(expr.left, scope);
			resolveColumns(expr.right, scope);
			return;
		case 'logical':
			expr.args.forEach((a) => resolveColumns(a, scope));
			return;
		case 'in':
			resolveColumns(expr.expr, scope);
			if (Array.isArray(expr.list)) expr.list.forEach((e) => resolveColumns(e, scope));
			return;
		case 'between':
			resolveColumns(expr.expr, scope);
			resolveColumns(expr.low, scope);
			resolveColumns(expr.high, scope);
			return;
		case 'like':
			resolveColumns(expr.expr, scope);
			resolveColumns(expr.pattern, scope);
			return;
		case 'isNull':
			resolveColumns(expr.expr, scope);
			return;
		case 'funcCall':
			expr.args.forEach((a) => resolveColumns(a, scope));
			return;
		case 'aggCall':
			if (expr.arg.kind !== 'star') resolveColumns(expr.arg, scope);
			return;
		case 'case':
			for (const c of expr.cases) {
				resolveColumns(c.when, scope);
				resolveColumns(c.then, scope);
			}
			if (expr.else) resolveColumns(expr.else, scope);
			return;
		case 'cast':
			resolveColumns(expr.expr, scope);
			return;
		default:
			return;
	}
}

// Surfaced for unit tests.
export const _internal = { resolveColumns, resolveQualifier };
