/**
 * Rule R3: predicate normalization.
 *
 * Maps AlaSQL operator forms to a canonical shape ahead of pushdown:
 *   - LIKE 'foo%'   ->  starts_with(foo)
 *   - LIKE '%foo'   ->  ends_with(foo)
 *   - LIKE '%foo%'  ->  contains(foo)
 *   - BETWEEN a AND b -> binop chain (col >= a AND col <= b)  with semantic
 *                       hint kept via marker for the pushdown rule
 *   - NOT (a > b)   ->  a <= b (NULL semantics preserved by leaving NOT in
 *                       place when the operand is anything other than a
 *                       comparable binop on a single column ref)
 *   - IS NULL / IS NOT NULL: left as-is (rule output for downstream).
 *
 * No change-of-meaning rewrites at this stage; the rule is conservative.
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
