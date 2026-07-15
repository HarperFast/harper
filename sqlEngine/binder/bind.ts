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

import type {
	ExprNode,
	SelectNode,
	StatementNode,
	TableRefNode,
	InsertNode,
	UpdateNode,
	DeleteNode,
} from '../parser/ast.ts';
import { EngineUnsupportedError } from '../errors.ts';

interface AttributeInfo {
	name: string;
	indexed: boolean;
	isPrimaryKey: boolean;
	/** Whether the attribute's index can serve `value === null` conditions —
	 * search.ts rejects null-valued searches on an index without indexNulls,
	 * and the primary key never indexes nulls. */
	indexNulls: boolean;
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

export interface BoundInsert extends InsertNode {
	boundTable: BoundTable;
}
export interface BoundUpdate extends UpdateNode {
	boundTable: BoundTable;
}
export interface BoundDelete extends DeleteNode {
	boundTable: BoundTable;
}

export function bind(stmt: StatementNode, _ctx: BindContext): StatementNode {
	switch (stmt.kind) {
		case 'select':
			return bindSelect(stmt);
		case 'insert':
			return bindInsert(stmt);
		case 'update':
			return bindUpdate(stmt);
		case 'delete':
			return bindDelete(stmt);
		default:
			throw new EngineUnsupportedError(`bind: unsupported statement kind`);
	}
}

/**
 * Mutations are single-table. We resolve the target table to a BoundTable (the
 * Resource class plus primaryKey/attributes) and leave column refs bare — the
 * write executor evaluates assignment/value expressions against bare-keyed rows,
 * exactly like the single-table SELECT path.
 */
function bindInsert(stmt: InsertNode): BoundInsert {
	const boundTable = bindTableRef(stmt.table, loadDatabases());
	return { ...stmt, table: { ...stmt.table, database: boundTable.database }, boundTable };
}

function bindUpdate(stmt: UpdateNode): BoundUpdate {
	const boundTable = bindTableRef(stmt.table, loadDatabases());
	// SET on the primary key can't be honored by Table.patch (identity is the call
	// argument, not the payload) — reporting the row as updated would be a false
	// success. Reject so `auto` falls back to legacy, which declines the re-key.
	if (boundTable.primaryKey && stmt.assignments.some((a) => a.column === boundTable.primaryKey)) {
		throw new EngineUnsupportedError(`UPDATE cannot change the primary key column "${boundTable.primaryKey}"`);
	}
	return { ...stmt, table: { ...stmt.table, database: boundTable.database }, boundTable };
}

function bindDelete(stmt: DeleteNode): BoundDelete {
	const boundTable = bindTableRef(stmt.table, loadDatabases());
	return { ...stmt, table: { ...stmt.table, database: boundTable.database }, boundTable };
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
		// Distinct effective aliases are required: the join row model keys columns
		// by `<alias>.<attr>`, so two tables sharing an alias would collide and
		// overwrite each other on merge.
		const seen = new Set<string>();
		for (const t of scope) {
			if (seen.has(t.effectiveAlias)) {
				throw new EngineUnsupportedError(
					`duplicate table alias "${t.effectiveAlias}" in join; give each joined table a distinct alias`
				);
			}
			seen.add(t.effectiveAlias);
		}
	}

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
		attributes?: { name: string; indexed?: boolean; indexNulls?: boolean }[];
		indices?: Record<string, { indexNulls?: boolean } | unknown>;
	};
	const primaryKey = r.primaryKey;
	const indices = r.indices ?? {};
	// indexNulls lives on both the attribute descriptor and the index dbi
	// (databases.ts sets each) — honor either.
	const attributes: AttributeInfo[] = (r.attributes ?? []).map((a) => ({
		name: a.name,
		indexed: !!a.indexed || !!indices[a.name] || a.name === primaryKey,
		isPrimaryKey: a.name === primaryKey,
		indexNulls:
			a.name !== primaryKey &&
			(!!a.indexNulls || !!(indices[a.name] as { indexNulls?: boolean } | undefined)?.indexNulls),
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
	// Each join's ON sees only the tables in scope at that point: FROM plus the
	// joins up to and including this one (scope[0..i+1]). Resolving against the
	// full scope would let an ON reference a not-yet-joined table or be falsely
	// flagged ambiguous against one.
	for (let i = 0; i < stmt.joins.length; i++) {
		const j = stmt.joins[i];
		if (j.on) resolveColumns(j.on, scope.slice(0, i + 2));
	}
	if (stmt.where) resolveColumns(stmt.where, scope);
	if (stmt.groupBy) for (const g of stmt.groupBy) resolveColumns(g, scope);
	if (stmt.having) resolveColumns(stmt.having, scope);
	if (stmt.orderBy) for (const o of stmt.orderBy) resolveColumns(o.expr, scope);
}

/** Resolves a qualifier string (alias or table name) to the canonical alias. */
function resolveQualifier(qualifier: string, scope: BoundTable[]): BoundTable | undefined {
	// Exact effective-alias match always wins (it is unique — duplicates are
	// rejected at bind time).
	const byAlias = scope.find((t) => t.effectiveAlias === qualifier);
	if (byAlias) return byAlias;
	// Fall back to base-table-name qualification (e.g. `dev.user.col` where the
	// table is unaliased). In a self-join the same base name appears more than
	// once; matching the first silently mis-binds, so reject as ambiguous.
	const byTable = scope.filter((t) => t.table === qualifier);
	if (byTable.length > 1) {
		throw new EngineUnsupportedError(
			`table qualifier "${qualifier}" is ambiguous across ${byTable
				.map((t) => t.effectiveAlias)
				.join(', ')}; qualify columns by alias`
		);
	}
	return byTable[0];
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
			} else if (scope.length === 1) {
				// Single-table query: an undeclared attribute (Harper tables are
				// schemaless) binds to the only table.
				expr.table = scope[0].effectiveAlias;
			} else {
				// Multi-table query: we cannot know which table an undeclared
				// attribute belongs to. Defaulting to the FROM table would silently
				// yield nulls when it actually lives on a joined table, so reject
				// and let 'auto' mode fall back to legacy.
				throw new EngineUnsupportedError(
					`column "${expr.name}" is not declared on any joined table; qualify it with a table alias`
				);
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
