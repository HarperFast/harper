import { parse } from '../../sqlTranslator/parser/parser.ts';
/**
 * Parses SQL into the statement AST (sqlTranslator/parser). The new engine never owns that AST beyond
 * this file and normalizer.ts, which converts it into the internal IR (ast.ts); the rest of the pipeline
 * only sees the IR.
 */

export interface SqlParseResult {
	ast: unknown;
	variant: string;
}

export function parseSql(sql: string): SqlParseResult {
	const trimmed = sql.trim();
	const ast = parse(trimmed);
	const variant = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
	return { ast, variant };
}
