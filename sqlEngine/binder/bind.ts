/**
 * Binder.
 *
 * Resolves the table reference in a SelectNode to a concrete Table class via
 * core/resources/databases.ts. Phase 1 only fills in `boundTable` and the
 * primaryKey + attribute names so downstream rules can validate columns. Type
 * inference and full alias scoping arrive in phase 2 alongside aggregates.
 */

import type { SelectNode, StatementNode } from '../parser/ast.ts';
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
	primaryKey?: string;
	attributes: AttributeInfo[];
	resource: unknown;
}

export interface BoundSelect extends SelectNode {
	boundTable: BoundTable;
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
		throw new EngineUnsupportedError(`bind: only SELECT supported in phase 1, got ${stmt.kind}`);
	}
	return bindSelect(stmt);
}

export function bindSelect(stmt: SelectNode): BoundSelect {
	const databases = loadDatabases();
	const databaseName = stmt.from.database || pickDefaultDatabase(databases, stmt.from.table);
	const dbEntry = databases[databaseName];
	if (!dbEntry) {
		throw new EngineUnsupportedError(`database "${databaseName}" not found`);
	}
	const resource = dbEntry[stmt.from.table];
	if (!resource) {
		throw new EngineUnsupportedError(`table "${databaseName}.${stmt.from.table}" not found`);
	}
	const r = resource as { primaryKey?: string; attributes?: { name: string; indexed?: boolean }[]; indices?: Record<string, unknown> };
	const primaryKey = r.primaryKey;
	const indices = r.indices ?? {};
	const attributes: AttributeInfo[] = (r.attributes ?? []).map((a) => ({
		name: a.name,
		indexed: !!a.indexed || !!indices[a.name] || a.name === primaryKey,
		isPrimaryKey: a.name === primaryKey,
	}));

	return {
		...stmt,
		from: { ...stmt.from, database: databaseName },
		boundTable: {
			database: databaseName,
			table: stmt.from.table,
			alias: stmt.from.alias,
			primaryKey,
			attributes,
			resource,
		},
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
