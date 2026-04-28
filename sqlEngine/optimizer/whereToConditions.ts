/**
 * Converts a (normalized) WHERE predicate into a Resource API condition tree
 * plus an optional residual expression that the engine must apply as a
 * post-scan Filter.
 *
 * The Resource API condition shape (see core/resources/search.ts:581):
 *   { attribute, value, comparator? }
 *   { conditions: Condition[], operator: 'and'|'or' }
 *
 * Comparator names use the canonical forms in
 * core/resources/search.ts:204 (equals, ne, lt, le, gt, ge, between, gele,
 * gelt, gtlt, gtle, starts_with, ends_with, contains).
 *
 * Anything that can't be represented as a condition (e.g., comparing two
 * columns, function calls in WHERE, OR mixed with non-attribute predicates)
 * is left in the residual.
 */

import type { ExprNode } from '../parser/ast.ts';

export interface DirectCondition {
	attribute?: string;
	value?: unknown;
	comparator?: string;
}

export interface CompoundCondition {
	conditions: ConditionNode[];
	operator: 'and' | 'or';
}

export type ConditionNode = DirectCondition | CompoundCondition;

export interface ConvertResult {
	conditions: ConditionNode[];
	operator: 'and' | 'or';
	residual?: ExprNode;
}

const BINARY_TO_COMPARATOR: Record<string, string> = {
	'=': 'equals',
	'!=': 'ne',
	'<>': 'ne',
	'<': 'lt',
	'<=': 'le',
	'>': 'gt',
	'>=': 'ge',
};

export function whereToConditions(predicate: ExprNode | undefined): ConvertResult {
	if (!predicate) {
		return { conditions: [], operator: 'and' };
	}
	const conjuncts = flattenAnd(predicate);
	const conditions: ConditionNode[] = [];
	const residuals: ExprNode[] = [];
	for (const e of conjuncts) {
		const cond = leafToCondition(e);
		if (cond) conditions.push(cond);
		else residuals.push(e);
	}
	const result: ConvertResult = { conditions, operator: 'and' };
	if (residuals.length > 0) {
		result.residual = residuals.length === 1 ? residuals[0] : { kind: 'logical', op: 'and', args: residuals };
	}
	return result;
}

function flattenAnd(expr: ExprNode): ExprNode[] {
	if (expr.kind === 'logical' && expr.op === 'and') {
		const out: ExprNode[] = [];
		for (const a of expr.args) out.push(...flattenAnd(a));
		return out;
	}
	return [expr];
}

function leafToCondition(expr: ExprNode): ConditionNode | undefined {
	switch (expr.kind) {
		case 'binop': {
			const comparator = BINARY_TO_COMPARATOR[expr.op];
			if (!comparator) return undefined;
			const colLit = pickColumnAndLiteral(expr.left, expr.right);
			if (!colLit) return undefined;
			return { attribute: colLit.column, comparator, value: colLit.value };
		}
		case 'in': {
			if (expr.expr.kind !== 'column') return undefined;
			if (!Array.isArray(expr.list)) return undefined;
			const values: unknown[] = [];
			for (const item of expr.list) {
				if (item.kind !== 'literal') return undefined;
				values.push(item.value);
			}
			const conditions: ConditionNode[] = values.map((v) => ({
				attribute: expr.expr.kind === 'column' ? expr.expr.name : '',
				comparator: expr.negated ? 'ne' : 'equals',
				value: v,
			}));
			return { conditions, operator: expr.negated ? 'and' : 'or' };
		}
		case 'between': {
			if (expr.expr.kind !== 'column') return undefined;
			if (expr.low.kind !== 'literal' || expr.high.kind !== 'literal') return undefined;
			if (expr.negated) return undefined;
			return {
				attribute: expr.expr.name,
				comparator: 'between',
				value: [expr.low.value, expr.high.value],
			};
		}
		case 'like': {
			if (expr.expr.kind !== 'column') return undefined;
			if (expr.pattern.kind !== 'literal' || typeof expr.pattern.value !== 'string') return undefined;
			if (expr.negated) return undefined;
			const pattern = expr.pattern.value;
			const startsPct = pattern.startsWith('%');
			const endsPct = pattern.endsWith('%');
			const middle = pattern.slice(startsPct ? 1 : 0, endsPct ? pattern.length - 1 : undefined);
			if (middle.includes('%') || middle.includes('_')) return undefined;
			if (startsPct && endsPct) {
				return { attribute: expr.expr.name, comparator: 'contains', value: middle };
			}
			if (startsPct) {
				return { attribute: expr.expr.name, comparator: 'ends_with', value: middle };
			}
			if (endsPct) {
				return { attribute: expr.expr.name, comparator: 'starts_with', value: middle };
			}
			return { attribute: expr.expr.name, comparator: 'equals', value: middle };
		}
		case 'isNull': {
			if (expr.expr.kind !== 'column') return undefined;
			return {
				attribute: expr.expr.name,
				comparator: expr.negated ? 'ne' : 'equals',
				value: null,
			};
		}
		case 'logical': {
			if (expr.op !== 'or') return undefined;
			const sub: ConditionNode[] = [];
			for (const a of expr.args) {
				const c = leafToCondition(a);
				if (!c) return undefined;
				sub.push(c);
			}
			return { conditions: sub, operator: 'or' };
		}
		default:
			return undefined;
	}
}

function pickColumnAndLiteral(a: ExprNode, b: ExprNode): { column: string; value: unknown } | undefined {
	if (a.kind === 'column' && b.kind === 'literal') return { column: a.name, value: b.value };
	if (b.kind === 'column' && a.kind === 'literal') return { column: b.name, value: a.value };
	return undefined;
}
