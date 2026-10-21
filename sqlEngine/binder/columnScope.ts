/**
 * Column-to-table resolution rules for multi-table SQL, shared by the v2 binder (bind.ts,
 * logical/build.ts) and the authorization layer (sqlTranslator/sql_statement_bucket.ts). One rule
 * set means a column is authorized against the same table the engine reads it from.
 *
 * Pure: callers decide whether an ambiguous or unknown reference throws (binder) or is refused
 * (authorization).
 */

export interface ScopeTable {
	table: string;
	/** alias ?? table — unique within a join scope. */
	effectiveAlias: string;
	attributes: readonly { name: string }[];
}

export type QualifierMatch<T extends ScopeTable> = { table: T } | { ambiguous: T[] } | undefined;

/**
 * An effective alias always wins; a base table name qualifies only when exactly one table in scope
 * has it (a self-join's base name is ambiguous).
 */
export function matchQualifier<T extends ScopeTable>(qualifier: string, scope: readonly T[]): QualifierMatch<T> {
	const byAlias = scope.find((t) => t.effectiveAlias === qualifier);
	if (byAlias) return { table: byAlias };
	const byTable = scope.filter((t) => t.table === qualifier);
	if (byTable.length > 1) return { ambiguous: byTable };
	return byTable.length === 1 ? { table: byTable[0] } : undefined;
}

export function declaringTables<T extends ScopeTable>(name: string, scope: readonly T[]): T[] {
	return scope.filter((t) => t.attributes.some((a) => a.name === name));
}

/** The left operand of `JOIN scope[rightIdx] USING (name)`: the nearest preceding declarer, else FROM. */
export function usingLeftOwner<T extends ScopeTable>(name: string, scope: readonly T[], rightIdx: number): T {
	for (let i = rightIdx - 1; i >= 0; i--) {
		if (scope[i].attributes.some((a) => a.name === name)) return scope[i];
	}
	return scope[0];
}
