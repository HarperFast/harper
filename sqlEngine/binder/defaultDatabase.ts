/**
 * Default-database resolution for schema-unqualified SQL table references.
 *
 * A bare `FROM customers` has to be resolved to a concrete `database.table` before it can be
 * either authorized or executed. This module is the single owner of that rule so the SQL
 * authorization layer (sqlTranslator/sql_statement_bucket.ts) and the engine's binder cannot
 * resolve the same bare name differently — a divergence that previously let an unqualified
 * statement be authorized against nothing while the engine happily resolved and touched a
 * real table (GHSA-5c29-q62v-jrwf).
 *
 * The rule: a bare name resolves only when exactly one database defines it. Zero matches or
 * an ambiguous match across databases is *not* resolved, and callers must fail closed.
 */

export type DatabaseRegistry = Record<string, Record<string, unknown>>;

let _databasesLoader: (() => DatabaseRegistry) | null = null;

/**
 * Override hook for tests. Restored to default by passing null.
 */
export function _setDatabasesLoader(loader: (() => DatabaseRegistry) | null): void {
	_databasesLoader = loader;
}

export function loadDatabases(): DatabaseRegistry {
	if (_databasesLoader) return _databasesLoader();
	const mod = require('../../resources/databases.js');
	return mod.getDatabases();
}

/**
 * Every database that defines `tableName`, in registry order.
 */
export function findDatabasesWithTable(databases: DatabaseRegistry, tableName: string): string[] {
	const matches: string[] = [];
	if (!databases || !tableName) return matches;
	for (const dbName of Object.keys(databases)) {
		if (databases[dbName]?.[tableName]) matches.push(dbName);
	}
	return matches;
}

/**
 * Resolve a bare table name against the live database registry.
 *
 * Returns undefined when the name resolves to zero databases or to more than one — the caller
 * decides how to fail, but must never treat undefined as "no table involved". Never throws:
 * the registry is unavailable on some paths (early startup, worker threads that have not
 * loaded databases yet), and an authorization caller must be able to tell "unresolvable" apart
 * from a crash so it can deny rather than 500.
 */
export function resolveDefaultDatabase(tableName: string): string | undefined {
	let databases: DatabaseRegistry;
	try {
		databases = loadDatabases();
	} catch {
		return undefined;
	}
	const matches = findDatabasesWithTable(databases, tableName);
	return matches.length === 1 ? matches[0] : undefined;
}
