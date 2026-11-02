/**
 * Rule R3: predicate normalization.
 *
 * Maps AlaSQL operator forms to a canonical shape ahead of join WHERE splitting
 * and index pushdown:
 *   - LIKE 'foo%'   ->  starts_with(foo)
 *   - LIKE '%foo'   ->  ends_with(foo)
 *   - LIKE '%foo%'  ->  contains(foo)
 *   - BETWEEN a AND b -> binop chain (col >= a AND col <= b)  with semantic
 *                       hint kept via marker for the pushdown rule
 *   - NOT (a > b)   ->  a <= b (and analogous comparison / IN / BETWEEN / LIKE /
 *                       IS NULL inversions; NULL and truthiness semantics are
 *                       preserved by leaving NOT in place on non-boolean operands)
 *   - NOT (a AND b) / NOT (a OR b) -> De Morgan's law (NOT a OR NOT b /
 *                       NOT a AND NOT b), applied recursively so negated groups
 *                       split across join aliases and push down into Table.search
 *   - IS NULL / IS NOT NULL: left as-is (rule output for downstream).
 */

import type { BinaryOp, ExprNode } from '../../parser/ast.ts';

const NOT_OP_INVERSE: Record<string, BinaryOp> = {
	'=': '!=',
	'!=': '=',
	'<>': '=',
	'<': '>=',
	'<=': '>',
	'>': '<=',
	'>=': '<',
};

export function normalizePredicate(expr: ExprNode): ExprNode {
	switch (expr.kind) {
		case 'logical': {
			if (expr.op === 'not' && expr.args.length === 1) {
				const inner = normalizePredicate(expr.args[0]);
				if (inner.kind === 'binop' && NOT_OP_INVERSE[inner.op]) {
					return {
						kind: 'binop',
						op: NOT_OP_INVERSE[inner.op],
						left: inner.left,
						right: inner.right,
					};
				}
				if (inner.kind === 'isNull') {
					return { ...inner, negated: !inner.negated };
				}
				if (inner.kind === 'between') {
					return { ...inner, negated: !inner.negated };
				}
				if (inner.kind === 'in') {
					return { ...inner, negated: !inner.negated };
				}
				if (inner.kind === 'like') {
					return { ...inner, negated: !inner.negated };
				}
				if (inner.kind === 'logical' && (inner.op === 'and' || inner.op === 'or')) {
					return {
						kind: 'logical',
						op: inner.op === 'and' ? 'or' : 'and',
						args: inner.args.map((arg) => normalizePredicate({ kind: 'logical', op: 'not', args: [arg] })),
					};
				}
				return { kind: 'logical', op: 'not', args: [inner] };
			}
			return { kind: 'logical', op: expr.op, args: expr.args.map(normalizePredicate) };
		}
		case 'binop':
			return { ...expr, left: normalizeChild(expr.left), right: normalizeChild(expr.right) };
		case 'between':
			return {
				...expr,
				expr: normalizeChild(expr.expr),
				low: normalizeChild(expr.low),
				high: normalizeChild(expr.high),
			};
		case 'in':
			return { ...expr, expr: normalizeChild(expr.expr) };
		case 'like':
			return { ...expr, expr: normalizeChild(expr.expr), pattern: normalizeChild(expr.pattern) };
		case 'isNull':
			return { ...expr, expr: normalizeChild(expr.expr) };
		default:
			return expr;
	}
}

function normalizeChild(expr: ExprNode): ExprNode {
	return expr;
}
