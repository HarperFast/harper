/**
 * Rule R8: scan validation.
 *
 * After all pushdowns, we walk every Scan in the plan and check that the
 * Resource API will accept the resulting target. Specifically: if no usable
 * index condition was pushed (and `allowFullScan` is off in config), we
 * throw EngineUnsupportedError naming the offending scan so the router can
 * fall back to legacy in 'auto' mode.
 *
 * Phase 1 keeps the check loose: any pushedFilter that maps to at least one
 * Resource API condition with an indexed attribute is sufficient. Filtering
 * decisions sit in optimizer/whereToConditions.ts.
 */

import type { LogicalPlan, LogicalScan } from '../../logical/op.ts';
import { EngineUnsupportedError } from '../../errors.ts';
import { whereToConditions } from '../whereToConditions.ts';
import type { ConditionNode } from '../whereToConditions.ts';
import { getSqlEngineConfig } from '../../config.ts';

export function validateScannable(plan: LogicalPlan): LogicalPlan | null {
	const cfg = getSqlEngineConfig();
	walk(plan, cfg.allowFullScan);
	return null;
}

function walk(plan: LogicalPlan, allowFullScan: boolean): void {
	if (plan.kind === 'Scan') {
		validateScan(plan, allowFullScan);
		return;
	}
	if ('input' in plan) walk(plan.input, allowFullScan);
	if ('left' in plan) walk(plan.left, allowFullScan);
	if ('right' in plan) walk(plan.right, allowFullScan);
}

function validateScan(scan: LogicalScan, allowFullScan: boolean): void {
	if (allowFullScan) return;
	// Inner side of an index-nested-loop join: served by a per-outer-row indexed
	// equality probe, not a standalone scan.
	if (scan.joinProbe) return;
	const { conditions } = whereToConditions(scan.pushedFilter);
	const hasIndexedCondition = conditions.some((c) => conditionUsesIndex(c, scan.boundTable?.attributes));
	if (hasIndexedCondition) return;
	// A pushed sort with no index-driving condition is a full ordered traversal of
	// the table — Table.search treats the sort pseudo-condition as needFullScan and
	// rejects it under allowFullScan:false (even with a LIMIT). So it is NOT
	// scannable here; reject so 'auto' falls back to legacy instead of erroring.
	throw new EngineUnsupportedError(
		`scan on "${scan.table.database}.${scan.table.table}" has no usable index condition`,
		scan.pushedFilter
	);
}

/**
 * Comparators that force a full scan even on an indexed attribute, because they
 * can't seek/range a B-tree index (suffix/substring match). These mirror
 * `core/resources/search.ts`'s `needFullScan` set — pushing one as the sole
 * condition makes Table.search throw a 403, not an EngineUnsupportedError, so it
 * must be rejected here (→ legacy fallback) instead of treated as index-served.
 * `ne` against a non-null value is the same (an inequality can't seek); `ne null`
 * (IS NOT NULL) is a range and stays index-servable.
 */
const FULL_SCAN_COMPARATORS = new Set(['ends_with', 'contains']);

function conditionUsesIndex(
	cond: ConditionNode,
	attributes: { name: string; indexed: boolean }[] | undefined
): boolean {
	if ('attribute' in cond && cond.attribute) {
		const a = attributes?.find((x) => x.name === cond.attribute);
		if (!a?.indexed) return false;
		if (FULL_SCAN_COMPARATORS.has(cond.comparator ?? '')) return false;
		if (cond.comparator === 'ne' && cond.value !== null) return false;
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
