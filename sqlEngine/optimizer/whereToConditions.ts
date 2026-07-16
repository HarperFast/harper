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

export type IndexedAttribute = { name: string; indexed: boolean; isPrimaryKey?: boolean; indexNulls?: boolean };

// Single-sided range comparators, split by which bound they set, and the fused
// comparator name that combines a lower + upper bound (matching the set
// core/resources/search.ts issues a single bounded getRange for).
const LOWER_COMPARATORS: Record<string, 'ge' | 'gt'> = { ge: 'ge', gt: 'gt' };
const UPPER_COMPARATORS: Record<string, 'le' | 'lt'> = { le: 'le', lt: 'lt' };

export function whereToConditions(predicate: ExprNode | undefined, attributes?: IndexedAttribute[]): ConvertResult {
	if (!predicate) {
		return { conditions: [], operator: 'and' };
	}
	const conjuncts = flattenAnd(predicate);
	const conditions: ConditionNode[] = [];
	const residuals: ExprNode[] = [];
	for (const e of conjuncts) {
		const cond = leafToCondition(e);
		// Only push a conjunct into the Resource API condition tree when every
		// attribute it references is indexed: Table.search runs searchByIndex on
		// each condition and throws "…is not indexed" for an unindexed attribute.
		// A full-scan comparator (e.g. LIKE→contains) on an *indexed* attribute is
		// still pushable — search applies it as a filter once another condition
		// drives the index (validateScannable enforces that a driver exists). When
		// `attributes` is unknown, keep the legacy behavior of pushing any
		// representable condition.
		if (cond && (attributes === undefined || conditionIsPushable(cond, attributes))) {
			conditions.push(cond);
			continue;
		}
		// A `!=`/NOT IN conjunct whose only unpushable leg is its not-null guard
		// (search rejects null-valued conditions on an index without indexNulls,
		// F-145): keep the value legs pushed — they carry the quoted-boolean/
		// numeric coercion branches the expression evaluator doesn't replicate —
		// and re-express just the guard as a residual IS NOT NULL filter.
		const split = cond && splitUnpushableNullGuards(cond, attributes);
		if (split) {
			if (split.pushable) conditions.push(split.pushable);
			residuals.push(...split.guards);
			continue;
		}
		residuals.push(e);
	}
	const result: ConvertResult = { conditions: fuseRangeBounds(conditions, attributes), operator: 'and' };
	if (residuals.length > 0) {
		result.residual = residuals.length === 1 ? residuals[0] : { kind: 'logical', op: 'and', args: residuals };
	}
	return result;
}

/**
 * If a condition is unpushable ONLY because it contains null-valued legs on
 * attributes whose index can't serve nulls (the `!=`/NOT IN not-null guard, or
 * an IS [NOT] NULL leg), split it: return the remaining pushable legs plus the
 * null legs re-expressed as residual isNull ExprNodes (evaluated post-scan with
 * correct three-valued logic). Returns undefined when the condition is
 * unpushable for any other reason (caller residualizes the whole conjunct) or
 * when nothing needed splitting.
 */
function splitUnpushableNullGuards(
	cond: ConditionNode,
	attributes: IndexedAttribute[] | undefined
): { pushable?: ConditionNode; guards: ExprNode[] } | undefined {
	if ('attribute' in cond && cond.attribute) {
		if (cond.value !== null) return undefined; // unpushable for a non-null-guard reason
		const a = attributes?.find((x) => x.name === cond.attribute);
		if (a?.indexed !== true || a.indexNulls) return undefined; // not the indexNulls case
		if (cond.comparator !== 'ne' && cond.comparator !== 'equals') return undefined;
		const guard: ExprNode = {
			kind: 'isNull',
			negated: cond.comparator === 'ne',
			expr: { kind: 'column', name: cond.attribute },
		};
		return { guards: [guard] };
	}
	if ('conditions' in cond && cond.operator === 'and') {
		// Salvage AND legs only: an OR containing an unservable null leg can't be
		// split into pushed-conditions + residual (the residual would over-filter).
		const pushable: ConditionNode[] = [];
		const guards: ExprNode[] = [];
		for (const c of cond.conditions) {
			if (conditionIsPushable(c, attributes)) {
				pushable.push(c);
				continue;
			}
			const sub = splitUnpushableNullGuards(c, attributes);
			if (!sub) return undefined;
			if (sub.pushable) pushable.push(sub.pushable);
			guards.push(...sub.guards);
		}
		if (guards.length === 0) return undefined;
		if (pushable.length === 0) return { guards };
		return {
			pushable: pushable.length === 1 ? pushable[0] : { conditions: pushable, operator: 'and' },
			guards,
		};
	}
	return undefined;
}

/**
 * Comparators that force a full scan even on an indexed attribute, because they
 * can't seek/range a B-tree index (suffix/substring match). These mirror
 * `core/resources/search.ts`'s `needFullScan` set. `ne` against a non-null value
 * is the same (an inequality can't seek); `ne null` (IS NOT NULL) is a range and
 * stays index-servable.
 */
const FULL_SCAN_COMPARATORS = new Set(['ends_with', 'contains']);

/**
 * Whether a condition can be pushed into Table.search at all: every attribute it
 * references must be indexed, because search runs searchByIndex per condition and
 * throws on an unindexed attribute. Comparator-agnostic — a full-scan comparator
 * on an indexed attribute is still pushable (it becomes a filter once another
 * condition drives the index). Null-valued conditions (IS [NOT] NULL and the
 * `!=`/NOT IN not-null guards) are pushable only when the index actually indexes
 * nulls — search throws "not indexed for nulls" otherwise (F-145), even when a
 * different condition drives the scan. Unpushable conditions become a residual
 * Filter (the expression evaluator's three-valued logic keeps NULL exclusion
 * correct on the residual path).
 */
export function conditionIsPushable(cond: ConditionNode, attributes: IndexedAttribute[] | undefined): boolean {
	if ('attribute' in cond && cond.attribute) {
		const a = attributes?.find((x) => x.name === cond.attribute);
		if (a?.indexed !== true) return false;
		if (cond.value === null && !a.indexNulls) return false;
		return true;
	}
	if ('conditions' in cond) {
		// Every leaf attribute must be indexed; a single unindexed leaf (in either
		// an AND or an OR) would make search throw when it evaluates that condition.
		return cond.conditions.every((c) => conditionIsPushable(c, attributes));
	}
	return false;
}

/**
 * Whether a condition can *drive* an index scan (seek/range), and therefore make
 * the scan valid without a full-table traversal. Stricter than pushability:
 * excludes full-scan comparators and unseekable inequalities. Shared with the R8
 * validateScannable rule so scannability and pushdown decisions can't drift.
 */
export function conditionUsesIndex(cond: ConditionNode, attributes: IndexedAttribute[] | undefined): boolean {
	if ('attribute' in cond && cond.attribute) {
		const a = attributes?.find((x) => x.name === cond.attribute);
		if (!a?.indexed) return false;
		if (FULL_SCAN_COMPARATORS.has(cond.comparator ?? '')) return false;
		if (cond.comparator === 'ne' && cond.value !== null) return false;
		// A null-valued condition can only seek an index that indexes nulls.
		if (cond.value === null && !a.indexNulls) return false;
		return true;
	}
	if ('conditions' in cond) {
		// AND: at least one indexable child suffices.
		// OR: every child must be indexable; otherwise the union requires a full scan.
		if (cond.operator === 'and') return cond.conditions.some((c) => conditionUsesIndex(c, attributes));
		if (cond.operator === 'or') return cond.conditions.every((c) => conditionUsesIndex(c, attributes));
	}
	return false;
}

/**
 * Whether a pushed sort can itself drive an index-ordered scan: its primary key
 * is a single column on the table's PRIMARY KEY. Table.search aligns such a sort
 * to the index's natural order (resources/Table.ts — it adds a `comparator:
 * 'sort'` condition), so the rows stream from the index already ordered and a
 * pushed LIMIT early-terminates (O(window)) — no separate in-memory sort. Shared
 * by the R8 validateScannable rule and the physical scan builder so scannability
 * and the `allowFullScan` flag can't drift. NOTE: because Table.search flags the
 * sort scan as `needFullScan`, the physical scan must pass `allowFullScan: true`
 * for it — see physicalIndexScan.
 *
 * Restricted to the PRIMARY KEY, because only there does index order provably
 * equal legacy's full-scan-then-stable-sort order. A non-PK secondary index
 * diverges from legacy in two ways (D-219): (1) a DESC sort reverses the whole
 * composite `[value, primaryKey]` entry, so rows tying on `value` come back in
 * primary-key-DESC order, whereas legacy's stable sort preserves primary-key-ASC
 * order for ties; and (2) the secondary index omits rows whose sort attribute is
 * null (they were never indexed), whereas a legacy full scan includes them. The
 * PK is unique (no ties) and always present (no null keys), so its ordered scan
 * matches legacy in both directions. Secondary-index sort streaming can be a
 * follow-up once those two divergences are handled.
 */
export function sortDrivesIndex(
	pushedSort: { expr: ExprNode }[] | undefined,
	attributes: IndexedAttribute[] | undefined
): boolean {
	const key = pushedSort?.[0];
	if (!key || key.expr.kind !== 'column') return false;
	const attr = attributes?.find((x) => x.name === (key.expr as { name: string }).name);
	return attr?.indexed === true && attr.isPrimaryKey === true;
}

function flattenAnd(expr: ExprNode): ExprNode[] {
	if (expr.kind === 'logical' && expr.op === 'and') {
		const out: ExprNode[] = [];
		for (const a of expr.args) out.push(...flattenAnd(a));
		return out;
	}
	return [expr];
}

/** True for a single-sided range leaf (`col >= a`, `col < b`, …) on the given attribute. */
function isRangeLeafOn(cond: ConditionNode, attribute: string): cond is DirectCondition & { comparator: string } {
	if ('conditions' in cond) return false;
	const comparator = cond.comparator;
	return (
		cond.attribute === attribute &&
		comparator != null &&
		(LOWER_COMPARATORS[comparator] != null || UPPER_COMPARATORS[comparator] != null)
	);
}

/**
 * Fuse a two-sided PRIMARY-KEY range written as separate conjuncts
 * (`id >= a AND id < b`) into a single bounded comparator (gele/gelt/gtlt/gtle)
 * so the storage layer issues one range-seek instead of an unbounded scan from
 * one bound filtered by the other (#1822). Without this, a leading `ge` streams
 * from `a` to the end of the table and filters `< b` in memory — O(table), not
 * O(window). (A SQL `BETWEEN` already maps directly to a single `between`
 * condition upstream, so it never needed fusing.)
 *
 * Deliberately limited to the primary key. The PK is always typed, so
 * Table.search's prepareConditions coerces the fused bounds to the key type and
 * the single seek's start/end always match stored-key ordering. A non-PK indexed
 * attribute may be UNTYPED (e.g. system `hdb_job.start_datetime`): coercion is
 * skipped, so a string literal against numeric storage would make the fused seek
 * return nothing. The two-condition path tolerates that mismatch via its
 * in-memory filter (JS type-juggling), so we leave non-PK ranges unfused.
 *
 * Only the unambiguous case is fused: exactly one lower bound (ge/gt) and one
 * upper bound (le/lt) on the PK within this AND group. Extra bounds (rare, e.g.
 * `id > 1 AND id > 5`) are left untouched — still correct, just not fused.
 */
function fuseRangeBounds(conditions: ConditionNode[], attributes?: IndexedAttribute[]): ConditionNode[] {
	const pk = attributes?.find((a) => a.isPrimaryKey)?.name;
	if (pk == null) return conditions;

	let lower: (DirectCondition & { comparator: string }) | undefined;
	let upper: (DirectCondition & { comparator: string }) | undefined;
	let lowerCount = 0;
	let upperCount = 0;
	for (const cond of conditions) {
		if (!isRangeLeafOn(cond, pk)) continue;
		if (LOWER_COMPARATORS[cond.comparator]) {
			lower = cond;
			lowerCount++;
		} else {
			upper = cond;
			upperCount++;
		}
	}
	if (lowerCount !== 1 || upperCount !== 1) return conditions;

	const fusedComparator = LOWER_COMPARATORS[lower!.comparator] + UPPER_COMPARATORS[upper!.comparator];
	const fused: ConditionNode[] = [];
	for (const cond of conditions) {
		if (cond === upper) continue; // merged into the lower bound's slot
		if (cond === lower) {
			fused.push({ attribute: pk, comparator: fusedComparator, value: [lower.value, upper!.value] });
			continue;
		}
		fused.push(cond);
	}
	return fused;
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
