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
 *
 * A limit is pushed into a Scan only when the scan carries no residual: if
 * part of the WHERE lowers to a post-scan PhysicalFilter (whereToConditions
 * residual, or an explicit residualFilter), Table.search would cap rows
 * *before* that filter runs and silently under-fetch. In that case the Limit
 * node is left above the residual filter.
 */

import type { LogicalPlan, LogicalScan } from '../../logical/op.ts';
import { whereToConditions } from '../whereToConditions.ts';

export function limitPushdown(plan: LogicalPlan): LogicalPlan | null {
	return rewrite(plan);
}

function scanHasResidual(scan: LogicalScan): boolean {
	if (scan.residualFilter) return true;
	return whereToConditions(scan.pushedFilter).residual !== undefined;
}

function rewrite(plan: LogicalPlan): LogicalPlan {
	switch (plan.kind) {
		case 'Limit': {
			const child = rewrite(plan.input);
			if (child.kind === 'Scan' && !child.pushedLimit && !scanHasResidual(child)) {
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
