/**
 * Rule R1: predicate pushdown.
 *
 * Pushes Filter into the Scan immediately below it. The portion that maps to
 * Resource API conditions is stored on Scan.pushedFilter (consumed by the
 * physical planner's whereToConditions). Anything that can't be expressed as
 * a condition is left as Scan.residualFilter and applied by a wrapping
 * PhysicalFilter at execution time.
 */

import type { LogicalPlan } from '../../logical/op.ts';

export function predicatePushdown(plan: LogicalPlan): LogicalPlan | null {
	return rewrite(plan);
}

function rewrite(plan: LogicalPlan): LogicalPlan {
	switch (plan.kind) {
		case 'Filter': {
			const child = rewrite(plan.input);
			if (child.kind === 'Scan') {
				const merged = child.pushedFilter
					? { kind: 'logical' as const, op: 'and' as const, args: [child.pushedFilter, plan.predicate] }
					: plan.predicate;
				return { ...child, pushedFilter: merged };
			}
			return { ...plan, input: child };
		}
		case 'Project':
			return { ...plan, input: rewrite(plan.input) };
		case 'Sort':
			return { ...plan, input: rewrite(plan.input) };
		case 'Limit':
			return { ...plan, input: rewrite(plan.input) };
		case 'Distinct':
			return { ...plan, input: rewrite(plan.input) };
		case 'Aggregate':
			// Recurse into input so WHERE filters below get pushed to the scan.
			// HAVING (a Filter above us) must NOT be pushed through the Aggregate.
			return { ...plan, input: rewrite(plan.input) };
		case 'Join':
			// Per-table WHERE conjuncts were attached as Filters directly above each
			// base scan by logical/build; push them in on both sides.
			return { ...plan, left: rewrite(plan.left), right: rewrite(plan.right) };
		default:
			return plan;
	}
}
