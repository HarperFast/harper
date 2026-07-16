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
	/**
	 * Set when a scan is locating rows for a subsequent UPDATE/DELETE, not serving
	 * a user-facing SELECT. A row whose TTL has passed but hasn't been swept by the
	 * background eviction scan yet is still physically present, and every other
	 * write surface (REST PUT/PATCH, ops update) still finds and overwrites it —
	 * they load by id without the freshness check a normal read applies. Without
	 * this, the scan that locates a mutation's target rows would silently drop one
	 * that's crossed its TTL between being written and being matched, so the
	 * mutation touches nothing and the TTL never resets (QA-269).
	 */
	includeExpiredRows?: boolean;
}
