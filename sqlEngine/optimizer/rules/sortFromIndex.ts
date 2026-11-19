/**
 * Rule R7: sort-from-index detection.
 *
 * If a Sort's keys all reference indexed attributes on a leaf Scan and the
 * Sort sits directly above the Scan (with no Filter that would change row
 * order), push the sort into Scan.pushedSort so Table.search returns rows in
 * the requested order. The Resource API only supports a single primary sort
 * with an optional `next` chain; phase 1 only handles the single-key case.
 *
 * If pushdown is not possible the Sort stays in place and the executor sorts
 * in memory (capped by config.maxSortRows).
 */

import type { LogicalPlan } from '../../logical/op.ts';

export function sortFromIndex(plan: LogicalPlan): LogicalPlan | null {
	return rewrite(plan);
}

function rewrite(plan: LogicalPlan): LogicalPlan {
	switch (plan.kind) {
		case 'Sort': {
			const child = rewrite(plan.input);
			if (child.kind === 'Scan' && !child.pushedSort) {
				if (plan.keys.length !== 1) return { ...plan, input: child };
				const key = plan.keys[0];
				if (key.expr.kind !== 'column') return { ...plan, input: child };
				const attribute = key.expr.name;
				const indexed = child.boundTable?.attributes.some((a) => a.name === attribute && a.indexed);
				if (!indexed) return { ...plan, input: child };
				return { ...child, pushedSort: [key] };
			}
			return { ...plan, input: child };
		}
		case 'Project':
			return { ...plan, input: rewrite(plan.input) };
		case 'Filter':
			return { ...plan, input: rewrite(plan.input) };
		case 'Limit':
			return { ...plan, input: rewrite(plan.input) };
		case 'Distinct':
			return { ...plan, input: rewrite(plan.input) };
		default:
			return plan;
	}
}
