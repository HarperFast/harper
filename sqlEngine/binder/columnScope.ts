// Shared with SQL authorization (sqlTranslator/sql_statement_bucket.ts) so a column is authorized
// against the table the engine reads it from.

export interface ScopeTable {
	table: string;
	effectiveAlias: string;
	attributes: readonly { name: string }[];
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
