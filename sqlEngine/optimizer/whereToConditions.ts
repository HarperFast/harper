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
			const attribute = colLit.column;
			// `=` matches either form (OR); `!=` must NOT match either form, and (SQL
			// three-valued logic / legacy AlaSQL) must also exclude NULLs, so it's an
			// AND that includes an explicit not-null guard.
			if (comparator === 'ne' && colLit.value !== null) {
				const conditions: ConditionNode[] = equalityBranches(attribute, colLit.value, 'ne');
				// `col != X` is UNKNOWN (not true) for a NULL col, so NULL rows are
				// excluded — match legacy by AND-ing an `IS NOT NULL` guard.
				conditions.push({ attribute, comparator: 'ne', value: null });
				return { conditions, operator: 'and' };
			}
			if (comparator === 'equals') {
				const branches = equalityBranches(attribute, colLit.value, 'equals');
				if (branches.length > 1) return { conditions: branches, operator: 'or' };
			}
			return { attribute, comparator, value: colLit.value };
		}
		case 'in': {
			if (expr.expr.kind !== 'column') return undefined;
			if (!Array.isArray(expr.list)) return undefined;
			const attribute = expr.expr.name;
			const variants: unknown[] = [];
			const seen = new Set<unknown>();
			for (const item of expr.list) {
				if (item.kind !== 'literal') return undefined;
				// Legacy AlaSQL evaluates IN with loose (`==`) membership, so a quoted
				// numeric (`id IN ('5')`) matches a numeric value (and vice versa).
				// Single `=` is NOT loose in legacy, so this coercion is IN-only.
				// Expanding to both forms keeps each branch an indexed equality lookup.
				for (const variant of looseEqualVariants(item.value)) {
					if (!seen.has(variant)) {
						seen.add(variant);
						variants.push(variant);
					}
				}
			}
			const conditions: ConditionNode[] = variants.map((v) => ({
				attribute,
				comparator: expr.negated ? 'ne' : 'equals',
				value: v,
			}));
			if (expr.negated) {
				// `col NOT IN (a, b)` is `col != a AND col != b AND col IS NOT NULL`:
				// a NULL col yields UNKNOWN (excluded), matching legacy AlaSQL 3VL.
				// Mirror the `!=` path's explicit not-null guard (without it, a NULL
				// row is returned by the new engine but dropped by legacy — a silent
				// divergence when the NOT IN is ANDed with another indexed conjunct).
				conditions.push({ attribute, comparator: 'ne', value: null });
			}
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

/**
 * Values an IN literal should match under legacy AlaSQL's loose (`==`) IN
 * semantics: a numeric string also matches the equivalent number and vice versa
 * (so `id IN ('5')` finds a numeric 5). Returns the original value plus any
 * cross-type form; each becomes its own indexed equality branch. The exact
 * round-trip guard (`String(Number(v)) === v`) avoids spurious variants for
 * non-canonical strings like '05' or '5px'.
 */
function looseEqualVariants(value: unknown): unknown[] {
	if (typeof value === 'string') {
		if (value.trim() !== '' && String(Number(value)) === value) return [value, Number(value)];
		return [value];
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return [value, String(value)];
	}
	return [value];
}

/**
 * The boolean a quoted boolean literal should also match under legacy coercion:
 * `'true'`/`'false'` (case-insensitive, trimmed) → the corresponding boolean.
 * Returns `undefined` for anything else (including actual booleans, which need no
 * expansion). Used for single `=`/`!=` only.
 */
function booleanVariant(value: unknown): boolean | undefined {
	if (typeof value !== 'string') return undefined;
	const v = value.trim().toLowerCase();
	if (v === 'true') return true;
	if (v === 'false') return false;
	return undefined;
}

/**
 * Equality/inequality branches for `col = X` / `col != X`, expanding a quoted
 * boolean literal to also cover the real boolean (legacy AlaSQL coercion). Each
 * branch stays an indexed equality lookup. The string branch is kept so a genuine
 * string column still matches; the boolean branch is added only when the literal
 * is `'true'`/`'false'`. (Numeric strings are NOT expanded for single `=`/`!=` —
 * legacy keeps those strict — so this is boolean-only, unlike the IN path.)
 */
function equalityBranches(attribute: string, value: unknown, comparator: 'equals' | 'ne'): DirectCondition[] {
	const branches: DirectCondition[] = [{ attribute, comparator, value }];
	const boolValue = booleanVariant(value);
	if (boolValue !== undefined) branches.push({ attribute, comparator, value: boolValue });
	return branches;
}
