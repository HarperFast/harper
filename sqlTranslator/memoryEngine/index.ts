/**
 * In-memory SQL engine for legacy SQL: runs a SELECT over rows already fetched from Harper's tables, which legacy
 * SQL passes as parameter arrays (`FROM ? AS t`). It reproduces AlaSQL 4's results, which legacy SQL returned for
 * years; see select.ts and expression.ts for what that entails.
 */
import * as ast from '../parser/ast.ts';
import { parse } from '../parser/parser.ts';
import { compileSelect, type Statement } from './select.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

function compileStatement(statement: any): Statement {
	if (statement instanceof ast.Select) return compileSelect(statement);
	throw new Error('Only SELECT statements run in the in-memory SQL engine');
}

/**
 * Compiles SQL text to a function of its parameters, as `alasql.compile` did: one statement returns its result,
 * several return an array of results.
 */
export function compile(sql: string): (params?: any) => any {
	const statements = parse(sql).statements.filter((statement: any) => statement !== undefined);
	const compiled = statements.map(compileStatement);
	if (compiled.length === 1) return (params?: any) => compiled[0](params ?? []);
	return (params?: any) => compiled.map((statement) => statement(params ?? []));
}

export function query(sql: string, params?: any[]): any {
	return compile(sql)(params);
}
