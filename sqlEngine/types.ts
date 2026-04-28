/**
 * Common types for the SQL engine.
 *
 * Row is the unit of data flowing through the operator pipeline. It is a plain
 * object whose keys are column names (or projected aliases) and values are SQL
 * values coerced to JS primitives.
 *
 * SqlType is the engine's internal type tag. It does not need to be exhaustive
 * with the SQL standard — it is used for coercion and function dispatch.
 */

export type Row = Record<string, unknown>;

export type SqlType =
	| 'null'
	| 'boolean'
	| 'int'
	| 'bigint'
	| 'number'
	| 'string'
	| 'date'
	| 'timestamp'
	| 'json'
	| 'blob'
	| 'array'
	| 'unknown';

export interface ColumnSchema {
	name: string;
	type: SqlType;
	nullable: boolean;
	source?: { table: string; attribute: string };
}

export interface SqlEngineContext {
	user?: unknown;
	signal?: AbortSignal;
	rowBudget?: number;
}
