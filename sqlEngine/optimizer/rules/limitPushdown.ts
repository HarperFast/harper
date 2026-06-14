/**
 * Rule R5: limit pushdown.
 *
 * If a Limit sits directly on top of a Scan (with optional Project/Sort that
 * preserve cardinality through-pushdown), push the limit/offset into the
 * Scan so Table.search returns only what we need.
 *
 * For phase 1 we push through Project unconditionally (a plain projection
 * preserves cardinality) and through Sort only when the Sort itself is
 * pushed into the scan (sortFromIndex rule has done that work).
 */

import type { LogicalPlan } from '../../logical/op.ts';

export function limitPushdown(plan: LogicalPlan): LogicalPlan | null {
	return rewrite(plan);
}

function rewrite(plan: LogicalPlan): LogicalPlan {
	switch (plan.kind) {
		case 'Limit': {
			const child = rewrite(plan.input);
			if (child.kind === 'Scan' && !child.pushedLimit) {
				return { ...child, pushedLimit: { limit: plan.limit, offset: plan.offset } };
			}
			if (child.kind === 'Project') {
				const sub = rewrite({ ...plan, input: child.input }) as LogicalPlan;
				return { ...child, input: sub };
			}
			return { ...plan, input: child };
		}
		case 'Project':
			return { ...plan, input: rewrite(plan.input) };
		case 'Sort':
			return { ...plan, input: rewrite(plan.input) };
		case 'Filter':
			return { ...plan, input: rewrite(plan.input) };
		case 'Distinct':
			return { ...plan, input: rewrite(plan.input) };
		default:
			return plan;
	}
}
