/**
 * Driver for phase-1 optimizer rules.
 *
 * The order here matters: predicate normalization happens first so other
 * rules see the canonical form; predicate pushdown then lifts the predicate
 * into the scan; sort-from-index inspects the bound table's index list to
 * decide whether the sort can be served by Table.search; limit pushdown
 * finally folds limit/offset into the scan; projection pushdown computes the
 * minimal attribute set; validateScannable enforces "no full scan without
 * opt-in".
 */

import type { LogicalPlan } from '../logical/op.ts';
import { applyRules } from './ruleEngine.ts';
import { predicatePushdown } from './rules/predicatePushdown.ts';
import { limitPushdown } from './rules/limitPushdown.ts';
import { sortFromIndex } from './rules/sortFromIndex.ts';
import { projectionPushdown } from './rules/projectionPushdown.ts';
import { validateScannable } from './rules/validateScannable.ts';
import { normalizePredicate } from './rules/predicateNormalize.ts';
import { planJoins } from './rules/planJoins.ts';

function normalizePredicates(plan: LogicalPlan): LogicalPlan | null {
	switch (plan.kind) {
		case 'Filter':
			return {
				...plan,
				predicate: normalizePredicate(plan.predicate),
				input: normalizePredicates(plan.input) ?? plan.input,
			};
		case 'Scan':
			return plan.pushedFilter ? { ...plan, pushedFilter: normalizePredicate(plan.pushedFilter) } : plan;
		case 'Join':
			return {
				...plan,
				on: plan.on ? normalizePredicate(plan.on) : plan.on,
				left: normalizePredicates(plan.left) ?? plan.left,
				right: normalizePredicates(plan.right) ?? plan.right,
			};
		default:
			if ('input' in plan) {
				return { ...plan, input: normalizePredicates(plan.input) ?? plan.input };
			}
			return plan;
	}
}

export function optimize(plan: LogicalPlan): LogicalPlan {
	const rules = [normalizePredicates, predicatePushdown, sortFromIndex, limitPushdown, projectionPushdown, planJoins];
	const optimized = applyRules(plan, rules);
	validateScannable(optimized);
	return optimized;
}
