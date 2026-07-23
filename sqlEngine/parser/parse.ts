/**
 * Thin wrapper around alasql.parse.
 *
 * The new engine never owns the raw AlaSQL parse output beyond this file —
 * normalizer.ts converts it into the internal IR (ast.ts) and the rest of the
 * pipeline only sees the IR.
 */

const alasql = require('alasql');

export interface AlaSqlParseResult {
	ast: unknown;
	variant: string;
}

export function parseSql(sql: string): AlaSqlParseResult {
	const trimmed = sql.trim();
	const ast = alasql.parse(trimmed);
	const variant = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
	return { ast, variant };
}

export { alasql };
