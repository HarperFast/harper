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
	const { conditions } = whereToConditions(scan.pushedFilter);
	const hasIndexedCondition = conditions.some((c) =>
		conditionUsesIndex(c, scan.boundTable?.attributes)
	);
	if (hasIndexedCondition) return;
	if (scan.pushedSort && scan.pushedSort.length > 0) return; // sort can drive a scan in some adapters
	throw new EngineUnsupportedError(
		`scan on "${scan.table.database}.${scan.table.table}" has no usable index condition`,
		scan.pushedFilter
	);
}

function conditionUsesIndex(
	cond: ConditionNode,
	attributes: { name: string; indexed: boolean }[] | undefined
): boolean {
	if ('attribute' in cond && cond.attribute) {
		const a = attributes?.find((x) => x.name === cond.attribute);
		return !!a?.indexed;
	}
	if ('conditions' in cond) {
		// AND: at least one indexable child suffices.
		// OR: every child must be indexable; otherwise the union requires a full scan.
		if (cond.operator === 'and') return cond.conditions.some((c) => conditionUsesIndex(c, attributes));
		if (cond.operator === 'or') return cond.conditions.every((c) => conditionUsesIndex(c, attributes));
	}
	return false;
}
