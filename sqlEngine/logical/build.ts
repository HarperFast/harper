/**
 * Builds an unoptimized logical plan from a bound SELECT.
 *
 * Non-aggregate shape:
 *   Project -> Limit -> Sort -> Filter(WHERE) -> Scan
 *
 * Aggregate shape:
 *   Project -> Limit -> Sort -> Filter(HAVING) -> Aggregate -> Filter(WHERE) -> Scan
 *
 * AggCollector walks all output expressions (projections, HAVING, ORDER BY) and
 * replaces each aggCall with a synthetic column reference (__agg_N__), building
 * the aggs list for LogicalAggregate in the process.  All downstream operators
 * therefore see only plain column references — no aggCall nodes escape above the
 * Aggregate node.
 *
 * GROUP BY is restricted to simple column references in this phase.
 */

import type { LogicalPlan, LogicalScan } from './op.ts';
import type { ExprNode, ProjectionNode, SelectNode, SortNode, StatementNode } from '../parser/ast.ts';
import type { BoundSelect } from '../binder/bind.ts';
import { EngineUnsupportedError } from '../errors.ts';

export function buildLogicalPlan(stmt: StatementNode): LogicalPlan {
	if (stmt.kind !== 'select') {
		throw new EngineUnsupportedError(`logical/build: only SELECT supported in phase 2, got ${stmt.kind}`);
	}
	return buildSelect(stmt as SelectNode & Partial<BoundSelect>);
}

// ---------------------------------------------------------------------------
// AggCollector: rewrites aggCall nodes → column refs, collects agg specs
// ---------------------------------------------------------------------------

interface AggSpec {
	name: string;
	arg: ExprNode | { kind: 'star' };
	outputName: string;
	distinct?: boolean;
}

class AggCollector {
	specs: AggSpec[] = [];

	private sig(expr: { name: string; arg: ExprNode | { kind: 'star' }; distinct?: boolean }): string {
		return JSON.stringify({ n: expr.name, a: expr.arg, d: !!expr.distinct });
	}

	rewrite(expr: ExprNode): ExprNode {
		switch (expr.kind) {
			case 'aggCall': {
				const key = this.sig(expr);
				let spec = this.specs.find((s) => this.sig(s) === key);
				if (!spec) {
					spec = { name: expr.name, arg: expr.arg, outputName: `__agg_${this.specs.length}__`, distinct: expr.distinct };
					this.specs.push(spec);
				}
				return { kind: 'column', name: spec.outputName };
			}
			case 'binop':
				return { ...expr, left: this.rewrite(expr.left), right: this.rewrite(expr.right) };
			case 'logical':
				return { ...expr, args: expr.args.map((a) => this.rewrite(a)) };
			case 'in': {
				const list = Array.isArray(expr.list) ? expr.list.map((e) => this.rewrite(e)) : expr.list;
				return { ...expr, expr: this.rewrite(expr.expr), list };
			}
			case 'between':
				return { ...expr, expr: this.rewrite(expr.expr), low: this.rewrite(expr.low), high: this.rewrite(expr.high) };
			case 'like':
				return { ...expr, expr: this.rewrite(expr.expr) };
			case 'isNull':
				return { ...expr, expr: this.rewrite(expr.expr) };
			case 'funcCall':
				return { ...expr, args: expr.args.map((a) => this.rewrite(a)) };
			case 'case':
				return {
					...expr,
					cases: expr.cases.map((c) => ({ when: this.rewrite(c.when), then: this.rewrite(c.then) })),
					else: expr.else ? this.rewrite(expr.else) : undefined,
				};
			default:
				return expr;
		}
	}
}

function containsAggCall(expr: ExprNode): boolean {
	switch (expr.kind) {
		case 'aggCall':
			return true;
		case 'binop':
			return containsAggCall(expr.left) || containsAggCall(expr.right);
		case 'logical':
			return expr.args.some(containsAggCall);
		case 'funcCall':
			return expr.args.some(containsAggCall);
		case 'case':
			return (
				expr.cases.some((c) => containsAggCall(c.when) || containsAggCall(c.then)) ||
				(!!expr.else && containsAggCall(expr.else))
			);
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

function buildSelect(stmt: SelectNode & Partial<BoundSelect>): LogicalPlan {
	const scan: LogicalScan = {
		kind: 'Scan',
		table: stmt.from,
		boundTable: stmt.boundTable,
	};

	let plan: LogicalPlan = scan;

	if (stmt.where) {
		plan = { kind: 'Filter', input: plan, predicate: stmt.where };
	}

	const hasGroupBy = stmt.groupBy != null && stmt.groupBy.length > 0;
	const hasAgg = stmt.projections.some((p) => containsAggCall(p.expr));

	if (hasGroupBy || hasAgg) {
		return buildAggregateSelect(stmt, plan);
	}

	// Non-aggregate path
	if (stmt.orderBy && stmt.orderBy.length > 0) {
		plan = { kind: 'Sort', input: plan, keys: stmt.orderBy };
	}
	if (stmt.limit != null || stmt.offset != null) {
		plan = { kind: 'Limit', input: plan, limit: stmt.limit, offset: stmt.offset };
	}
	plan = { kind: 'Project', input: plan, projections: stmt.projections };
	if (stmt.distinct) {
		plan = { kind: 'Distinct', input: plan };
	}
	return plan;
}

function buildAggregateSelect(stmt: SelectNode & Partial<BoundSelect>, afterWhere: LogicalPlan): LogicalPlan {
	const groupKeys = stmt.groupBy ?? [];

	// Phase 2: GROUP BY only supports column references
	for (const k of groupKeys) {
		if (k.kind !== 'column') {
			throw new EngineUnsupportedError(
				'GROUP BY supports only column references in phase 2 (complex expressions not yet supported)',
				k,
			);
		}
	}

	// Rewrite aggCalls → column refs in all output expressions
	const collector = new AggCollector();

	const rewrittenProjections: ProjectionNode[] = stmt.projections.map((p) => ({
		...p,
		expr: collector.rewrite(p.expr),
	}));

	const rewrittenHaving: ExprNode | undefined = stmt.having ? collector.rewrite(stmt.having) : undefined;

	const rewrittenOrderBy: SortNode[] | undefined = stmt.orderBy?.map((k) => ({
		...k,
		expr: collector.rewrite(k.expr),
	}));

	let plan: LogicalPlan = {
		kind: 'Aggregate',
		input: afterWhere,
		groupKeys,
		aggs: collector.specs,
	};

	if (rewrittenHaving) {
		plan = { kind: 'Filter', input: plan, predicate: rewrittenHaving };
	}

	if (rewrittenOrderBy && rewrittenOrderBy.length > 0) {
		plan = { kind: 'Sort', input: plan, keys: rewrittenOrderBy };
	}

	if (stmt.limit != null || stmt.offset != null) {
		plan = { kind: 'Limit', input: plan, limit: stmt.limit, offset: stmt.offset };
	}

	plan = { kind: 'Project', input: plan, projections: rewrittenProjections };

	if (stmt.distinct) {
		plan = { kind: 'Distinct', input: plan };
	}

	return plan;
}
