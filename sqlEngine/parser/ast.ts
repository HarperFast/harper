/**
 * Internal SQL AST (IR).
 *
 * This is the boundary at which AlaSQL types die. The parser/normalizer.ts
 * walks an `alasql.yy.*` tree and produces these plain objects. Nothing
 * downstream imports from `alasql`.
 */

import type { SqlType } from '../types.ts';

export type StatementNode = SelectNode | InsertNode | UpdateNode | DeleteNode;

export interface SelectNode {
	kind: 'select';
	distinct: boolean;
	projections: ProjectionNode[];
	from: TableRefNode;
	joins: JoinNode[];
	where?: ExprNode;
	groupBy?: ExprNode[];
	having?: ExprNode;
	orderBy?: SortNode[];
	limit?: number;
	offset?: number;
}

export interface InsertNode {
	kind: 'insert';
	table: TableRefNode;
	columns: string[];
	values: ExprNode[][] | SelectNode;
}

export interface UpdateNode {
	kind: 'update';
	table: TableRefNode;
	assignments: { column: string; expr: ExprNode }[];
	where?: ExprNode;
}

export interface DeleteNode {
	kind: 'delete';
	table: TableRefNode;
	where?: ExprNode;
}

export interface TableRefNode {
	database: string;
	table: string;
	alias?: string;
}

export interface JoinNode {
	type: 'inner' | 'left' | 'right' | 'full' | 'cross';
	table: TableRefNode;
	on?: ExprNode;
	using?: string[];
}

export interface ProjectionNode {
	expr: ExprNode;
	alias?: string;
	/**
	 * Default output-column label when no `alias` is given, computed from the
	 * original (pre-aggregate-rewrite) expression to match the legacy AlaSQL
	 * column name (e.g. `COUNT(*)`, `SUM(price)`). Without it, an unaliased
	 * aggregate would surface under the engine's internal `__agg_N__` name.
	 */
	label?: string;
}

export interface SortNode {
	expr: ExprNode;
	descending: boolean;
	nullsFirst?: boolean;
}

export type BinaryOp = '=' | '!=' | '<>' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%' | '||';

export type ExprNode =
	| { kind: 'column'; table?: string; name: string }
	| { kind: 'literal'; value: unknown; sqlType: SqlType }
	| { kind: 'binop'; op: BinaryOp; left: ExprNode; right: ExprNode }
	| { kind: 'logical'; op: 'and' | 'or' | 'not'; args: ExprNode[] }
	| { kind: 'in'; expr: ExprNode; list: ExprNode[] | SelectNode; negated: boolean }
	| { kind: 'between'; expr: ExprNode; low: ExprNode; high: ExprNode; negated: boolean }
	| { kind: 'like'; expr: ExprNode; pattern: ExprNode; escape?: ExprNode; negated: boolean }
	| { kind: 'isNull'; expr: ExprNode; negated: boolean }
	| { kind: 'case'; cases: { when: ExprNode; then: ExprNode }[]; else?: ExprNode }
	| { kind: 'funcCall'; name: string; args: ExprNode[]; distinct?: boolean }
	| { kind: 'aggCall'; name: string; arg: ExprNode | { kind: 'star' }; distinct?: boolean }
	| { kind: 'cast'; expr: ExprNode; targetType: SqlType }
	| { kind: 'star'; table?: string }
	| { kind: 'subquery'; query: SelectNode; correlated: boolean };
