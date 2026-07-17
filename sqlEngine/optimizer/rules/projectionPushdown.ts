/**
 * Rule R2: projection pushdown.
 *
 * Walks the plan from the root and computes the minimal set of attributes
 * each Scan must produce. The set is stored on Scan.projection and is mapped
 * to Resource API target.select by the physical planner.
 *
 * If any projection includes a `*`, we leave the scan's projection
 * unrestricted (undefined → fetch all attributes). This keeps semantics
 * matching legacy SQL. We can tighten this later by binding `*` to the
 * concrete attribute list at plan time.
 */

import type { ExprNode, ProjectionNode, SortNode } from '../../parser/ast.ts';
import type { LogicalPlan } from '../../logical/op.ts';

export function projectionPushdown(plan: LogicalPlan): LogicalPlan | null {
	return rewrite(plan, undefined);
}

function rewrite(plan: LogicalPlan, required: Set<string> | undefined): LogicalPlan {
	switch (plan.kind) {
		case 'Project': {
			if (containsStar(plan.projections)) {
				return { ...plan, input: rewrite(plan.input, undefined) };
			}
			const need = new Set<string>();
			for (const p of plan.projections) collectColumns(p.expr, need);
			return { ...plan, input: rewrite(plan.input, need) };
		}
		case 'Filter': {
			if (required) {
				const merged = new Set(required);
				collectColumns(plan.predicate, merged);
				return { ...plan, input: rewrite(plan.input, merged) };
			}
			return { ...plan, input: rewrite(plan.input, undefined) };
		}
		case 'Sort': {
			if (required) {
				const merged = new Set(required);
				for (const k of plan.keys) collectColumns(k.expr, merged);
				return { ...plan, input: rewrite(plan.input, merged) };
			}
			return { ...plan, input: rewrite(plan.input, undefined) };
		}
		case 'Limit':
			return { ...plan, input: rewrite(plan.input, required) };
		case 'Distinct':
			return { ...plan, input: rewrite(plan.input, required) };
		case 'Aggregate': {
			// `required` from above contains synthetic __agg_N__ names that don't
			// exist in the input. Compute the actual columns the input must supply.
			const need = new Set<string>();
			for (const k of plan.groupKeys) collectColumns(k, need);
			for (const a of plan.aggs) {
				if (a.arg.kind !== 'star') collectColumns(a.arg as ExprNode, need);
			}
			return { ...plan, input: rewrite(plan.input, need.size > 0 ? need : undefined) };
		}
		case 'Scan': {
			if (!required) return { ...plan, projection: undefined };
			if (plan.pushedFilter) collectColumns(plan.pushedFilter, required);
			if (plan.pushedSort) for (const k of plan.pushedSort) collectColumns(k.expr, required);
			if (plan.residualFilter) collectColumns(plan.residualFilter, required);
			return { ...plan, projection: [...required].sort() };
		}
		default:
			return plan;
	}
}

function containsStar(projections: ProjectionNode[]): boolean {
	for (const p of projections) {
		if (containsStarExpr(p.expr)) return true;
	}
	return false;
}

function containsStarExpr(expr: ExprNode): boolean {
	if (expr.kind === 'star') return true;
	if (expr.kind === 'binop') return containsStarExpr(expr.left) || containsStarExpr(expr.right);
	if (expr.kind === 'logical') return expr.args.some(containsStarExpr);
	if (expr.kind === 'funcCall') return expr.args.some(containsStarExpr);
	return false;
}

function collectColumns(expr: ExprNode, out: Set<string>): void {
	switch (expr.kind) {
		case 'column':
			out.add(expr.name);
			return;
		case 'binop':
			collectColumns(expr.left, out);
			collectColumns(expr.right, out);
			return;
		case 'logical':
			expr.args.forEach((a) => collectColumns(a, out));
			return;
		case 'in':
			collectColumns(expr.expr, out);
			if (Array.isArray(expr.list)) {
				expr.list.forEach((e) => collectColumns(e, out));
			}
			return;
		case 'between':
			collectColumns(expr.expr, out);
			collectColumns(expr.low, out);
			collectColumns(expr.high, out);
			return;
		case 'like':
			collectColumns(expr.expr, out);
			collectColumns(expr.pattern, out);
			return;
		case 'isNull':
			collectColumns(expr.expr, out);
			return;
		case 'funcCall':
			expr.args.forEach((a) => collectColumns(a, out));
			return;
		case 'aggCall':
			if (expr.arg.kind !== 'star') collectColumns(expr.arg, out);
			return;
		case 'case':
			for (const c of expr.cases) {
				collectColumns(c.when, out);
				collectColumns(c.then, out);
			}
			if (expr.else) collectColumns(expr.else, out);
			return;
		case 'star':
		case 'literal':
			return;
		default:
			return;
	}
}

// Surface a helper for unit tests / external rules.
export const _internal = { collectColumns, containsStar };

// Helper that other rules can use without re-walking plans.
export function collectRequiredColumnsFromKeys(keys: SortNode[]): Set<string> {
	const out = new Set<string>();
	for (const k of keys) collectColumns(k.expr, out);
	return out;
}
