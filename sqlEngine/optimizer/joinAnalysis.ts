/**
 * Shared analysis of a LogicalJoin's ON clause, used by both the join-strategy
 * rule (optimizer/rules/planJoins.ts) and the physical planner (physical/plan).
 *
 * In a left-deep tree the right child is always a single base table (a Scan,
 * optionally wrapped in a Filter for its own single-table WHERE conjuncts). We
 * split the ON predicate into:
 *   - equi-pairs `outer = inner`, where `inner` references only the right
 *     table's alias and `outer` references only left-side aliases;
 *   - a residual predicate (non-equi conditions, or equalities that don't cleanly
 *     separate across the join boundary) applied on the merged row.
 */

import type { ExprNode } from '../parser/ast.ts';
import type { LogicalJoin, LogicalScan } from '../logical/op.ts';

export interface EquiPair {
	outer: ExprNode;
	inner: ExprNode;
}

export interface JoinAnalysis {
	rightAlias: string;
	rightScan: LogicalScan;
	equiPairs: EquiPair[];
	residualOn?: ExprNode;
}

/** Unwraps the right child to its base Scan (through an optional Filter). */
export function rightBaseScan(join: LogicalJoin): LogicalScan | null {
	let node = join.right;
	if (node.kind === 'Filter') node = node.input;
	return node.kind === 'Scan' ? node : null;
}

export function analyzeJoin(join: LogicalJoin): JoinAnalysis | null {
	const rightScan = rightBaseScan(join);
	if (!rightScan || !rightScan.alias) return null;
	const rightAlias = rightScan.alias;

	const equiPairs: EquiPair[] = [];
	const residuals: ExprNode[] = [];

	for (const conjunct of flattenAnd(join.on)) {
		const pair = asEquiPair(conjunct, rightAlias);
		if (pair) equiPairs.push(pair);
		else residuals.push(conjunct);
	}

	return {
		rightAlias,
		rightScan,
		equiPairs,
		residualOn: residuals.length > 0 ? andAll(residuals) : undefined,
	};
}

/**
 * Picks the equi-pair to drive an index-nested-loop probe: its inner operand is
 * a plain column on the right table that is indexed. Returns null when no
 * equi-pair qualifies (caller falls back to hash / nested-loop).
 */
export function pickIndexedProbe(analysis: JoinAnalysis): { pair: EquiPair; attribute: string } | null {
	const attrs = analysis.rightScan.boundTable?.attributes ?? [];
	for (const pair of analysis.equiPairs) {
		if (pair.inner.kind === 'column' && pair.inner.table === analysis.rightAlias) {
			const attr = attrs.find((a) => a.name === (pair.inner as { name: string }).name);
			if (attr?.indexed) return { pair, attribute: pair.inner.name };
		}
	}
	return null;
}

function asEquiPair(expr: ExprNode, rightAlias: string): EquiPair | null {
	if (expr.kind !== 'binop' || expr.op !== '=') return null;
	const leftAliases = referencedAliases(expr.left);
	const rightAliases = referencedAliases(expr.right);
	// One operand must reference only the right table; the other only left-side
	// table(s) (and at least one — a literal isn't a join key).
	if (onlyAlias(rightAliases, rightAlias) && leftAliases.size > 0 && !leftAliases.has(rightAlias)) {
		return { outer: expr.left, inner: expr.right };
	}
	if (onlyAlias(leftAliases, rightAlias) && rightAliases.size > 0 && !rightAliases.has(rightAlias)) {
		return { outer: expr.right, inner: expr.left };
	}
	return null;
}

function onlyAlias(aliases: Set<string>, alias: string): boolean {
	return aliases.size === 1 && aliases.has(alias);
}

function flattenAnd(expr: ExprNode | undefined): ExprNode[] {
	if (!expr) return [];
	if (expr.kind === 'logical' && expr.op === 'and') return expr.args.flatMap(flattenAnd);
	return [expr];
}

function andAll(exprs: ExprNode[]): ExprNode {
	return exprs.length === 1 ? exprs[0] : { kind: 'logical', op: 'and', args: exprs };
}

export function referencedAliases(expr: ExprNode, out: Set<string> = new Set()): Set<string> {
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
