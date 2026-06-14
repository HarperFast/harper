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
import type { ExprNode, JoinNode, ProjectionNode, SelectNode, SortNode, StatementNode } from '../parser/ast.ts';
import type { BoundSelect, BoundTable } from '../binder/bind.ts';
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
					spec = {
						name: expr.name,
						arg: expr.arg,
						outputName: `__agg_${this.specs.length}__`,
						distinct: expr.distinct,
					};
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
	let plan: LogicalPlan = stmt.joins.length > 0 ? buildJoinSource(stmt) : buildSingleTableSource(stmt);

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

// ---------------------------------------------------------------------------
// Source construction (Scan / Join tree + WHERE)
// ---------------------------------------------------------------------------

function buildSingleTableSource(stmt: SelectNode & Partial<BoundSelect>): LogicalPlan {
	const scan: LogicalScan = {
		kind: 'Scan',
		table: stmt.from,
		boundTable: stmt.boundTable,
	};
	if (stmt.where) {
		return { kind: 'Filter', input: scan, predicate: stmt.where };
	}
	return scan;
}

/**
 * Builds a left-deep join tree from FROM + joins. WHERE conjuncts that
 * reference a single table are attached as a Filter directly above that table's
 * Scan (so predicate pushdown lowers them into the index scan); conjuncts that
 * span tables (or are constant) become a residual Filter above the whole tree.
 */
function buildJoinSource(stmt: SelectNode & Partial<BoundSelect>): LogicalPlan {
	const scope = stmt.scope as BoundTable[];

	// alias → single-table WHERE conjuncts; cross-table/constant conjuncts → residual.
	const perAlias = new Map<string, ExprNode[]>();
	const residual: ExprNode[] = [];
	if (stmt.where) {
		for (const conjunct of flattenAnd(stmt.where)) {
			const aliases = referencedAliases(conjunct);
			if (aliases.size === 1) {
				const alias = [...aliases][0];
				const list = perAlias.get(alias);
				if (list) list.push(conjunct);
				else perAlias.set(alias, [conjunct]);
			} else {
				residual.push(conjunct);
			}
		}
	}

	const makeScan = (bound: BoundTable): LogicalPlan => {
		const scan: LogicalScan = {
			kind: 'Scan',
			table: { database: bound.database, table: bound.table, alias: bound.alias },
			boundTable: bound,
			alias: bound.effectiveAlias,
		};
		const conjuncts = perAlias.get(bound.effectiveAlias);
		if (conjuncts && conjuncts.length > 0) {
			return { kind: 'Filter', input: scan, predicate: andAll(conjuncts) };
		}
		return scan;
	};

	// Left-deep: ((from JOIN j0) JOIN j1) ...
	let plan: LogicalPlan = makeScan(scope[0]);
	for (let i = 0; i < stmt.joins.length; i++) {
		const join: JoinNode = stmt.joins[i];
		const right = makeScan(scope[i + 1]);
		const on = join.on ?? usingToOn(join, scope, i + 1);
		plan = {
			kind: 'Join',
			left: plan,
			right,
			on,
			type: join.type === 'right' || join.type === 'full' ? 'inner' : join.type,
		};
	}

	if (residual.length > 0) {
		plan = { kind: 'Filter', input: plan, predicate: andAll(residual) };
	}
	return plan;
}

/** Expands a USING (c1, c2, …) clause into an equi-ON between the joined table and its left-side owner. */
function usingToOn(join: JoinNode, scope: BoundTable[], rightIdx: number): ExprNode | undefined {
	if (!join.using || join.using.length === 0) return undefined;
	const rightAlias = scope[rightIdx].effectiveAlias;
	const eqs: ExprNode[] = join.using.map((col) => {
		// Left owner: nearest preceding table that declares the column.
		let leftAlias = scope[0].effectiveAlias;
		for (let i = rightIdx - 1; i >= 0; i--) {
			if (scope[i].attributes.some((a) => a.name === col)) {
				leftAlias = scope[i].effectiveAlias;
				break;
			}
		}
		return {
			kind: 'binop',
			op: '=',
			left: { kind: 'column', table: leftAlias, name: col },
			right: { kind: 'column', table: rightAlias, name: col },
		};
	});
	return andAll(eqs);
}

function flattenAnd(expr: ExprNode): ExprNode[] {
	if (expr.kind === 'logical' && expr.op === 'and') {
		return expr.args.flatMap(flattenAnd);
	}
	return [expr];
}

function andAll(exprs: ExprNode[]): ExprNode {
	if (exprs.length === 1) return exprs[0];
	return { kind: 'logical', op: 'and', args: exprs };
}

/** Collects the distinct table aliases (column.table) referenced by an expression. */
function referencedAliases(expr: ExprNode, out: Set<string> = new Set()): Set<string> {
	switch (expr.kind) {
		case 'column':
			if (expr.table) out.add(expr.table);
			return out;
		case 'binop':
			referencedAliases(expr.left, out);
			referencedAliases(expr.right, out);
			return out;
		case 'logical':
			expr.args.forEach((a) => referencedAliases(a, out));
			return out;
		case 'in':
			referencedAliases(expr.expr, out);
			if (Array.isArray(expr.list)) expr.list.forEach((e) => referencedAliases(e, out));
			return out;
		case 'between':
			referencedAliases(expr.expr, out);
			referencedAliases(expr.low, out);
			referencedAliases(expr.high, out);
			return out;
		case 'like':
			referencedAliases(expr.expr, out);
			referencedAliases(expr.pattern, out);
			return out;
		case 'isNull':
			referencedAliases(expr.expr, out);
			return out;
		case 'funcCall':
			expr.args.forEach((a) => referencedAliases(a, out));
			return out;
		case 'aggCall':
			if (expr.arg.kind !== 'star') referencedAliases(expr.arg, out);
			return out;
		case 'case':
			for (const c of expr.cases) {
				referencedAliases(c.when, out);
				referencedAliases(c.then, out);
			}
			if (expr.else) referencedAliases(expr.else, out);
			return out;
		case 'cast':
			referencedAliases(expr.expr, out);
			return out;
		default:
			return out;
	}
}

function buildAggregateSelect(stmt: SelectNode & Partial<BoundSelect>, afterWhere: LogicalPlan): LogicalPlan {
	const groupKeys = stmt.groupBy ?? [];

	// Phase 2: GROUP BY only supports column references
	for (const k of groupKeys) {
		if (k.kind !== 'column') {
			throw new EngineUnsupportedError(
				'GROUP BY supports only column references in phase 2 (complex expressions not yet supported)',
				k
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
