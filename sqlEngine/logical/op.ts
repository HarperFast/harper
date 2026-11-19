/**
 * Logical operators.
 *
 * The logical plan is a tree of these nodes produced by logical/build.ts from
 * the bound IR and rewritten by optimizer/rules/* before being lowered to a
 * physical plan in physical/plan.ts.
 */

import type { ExprNode, ProjectionNode, SortNode, TableRefNode } from '../parser/ast.ts';
import type { BoundTable } from '../binder/bind.ts';

export type LogicalPlan =
	| LogicalScan
	| LogicalFilter
	| LogicalProject
	| LogicalJoin
	| LogicalAggregate
	| LogicalSort
	| LogicalLimit
	| LogicalDistinct
	| LogicalInsert
	| LogicalUpdate
	| LogicalDelete;

export interface LogicalScan {
	kind: 'Scan';
	table: TableRefNode;
	boundTable?: BoundTable;
	/**
	 * Set in join queries: the canonical alias this scan's rows are qualified by
	 * (`<alias>.<attr>`). Undefined for single-table queries (bare-keyed rows).
	 */
	alias?: string;
	pushedFilter?: ExprNode;
	pushedSort?: SortNode[];
	pushedLimit?: { limit?: number; offset?: number };
	projection?: string[];
	residualFilter?: ExprNode;
	/**
	 * Set when this scan is the inner side of an index-nested-loop join: it is
	 * re-probed per outer row via an equality on `keyAttribute` (which must be
	 * indexed), so validateScannable treats it as index-served rather than a
	 * standalone full scan.
	 */
	joinProbe?: { keyAttribute: string };
}

export interface LogicalFilter {
	kind: 'Filter';
	input: LogicalPlan;
	predicate: ExprNode;
}

export interface LogicalProject {
	kind: 'Project';
	input: LogicalPlan;
	projections: ProjectionNode[];
}

export interface LogicalJoin {
	kind: 'Join';
	left: LogicalPlan;
	right: LogicalPlan;
	on?: ExprNode;
	type: 'inner' | 'left' | 'cross';
	strategy?: 'relationship' | 'indexNL' | 'hash' | 'nestedLoop';
}

export interface LogicalAggregate {
	kind: 'Aggregate';
	input: LogicalPlan;
	groupKeys: ExprNode[];
	aggs: { name: string; arg: ExprNode | { kind: 'star' }; outputName: string; distinct?: boolean }[];
	having?: ExprNode;
}

export interface LogicalSort {
	kind: 'Sort';
	input: LogicalPlan;
	keys: SortNode[];
}

export interface LogicalLimit {
	kind: 'Limit';
	input: LogicalPlan;
	limit?: number;
	offset?: number;
}

export interface LogicalDistinct {
	kind: 'Distinct';
	input: LogicalPlan;
	keys?: ExprNode[];
}

export interface LogicalInsert {
	kind: 'Insert';
	table: TableRefNode;
	rows: ExprNode[][] | LogicalPlan;
	columns: string[];
}

export interface LogicalUpdate {
	kind: 'Update';
	table: TableRefNode;
	assignments: { column: string; expr: ExprNode }[];
	selector: LogicalPlan;
}

export interface LogicalDelete {
	kind: 'Delete';
	table: TableRefNode;
	selector: LogicalPlan;
}
