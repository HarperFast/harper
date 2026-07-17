/**
 * Fixed-point rule engine. Phase 0 scaffold; rules under rules/ are added in
 * phase 1+.
 */

import type { LogicalPlan } from '../logical/op.ts';

export type Rule = (plan: LogicalPlan) => LogicalPlan | null;

export function applyRules(plan: LogicalPlan, rules: Rule[]): LogicalPlan {
	let current = plan;
	let changed = true;
	let iterations = 0;
	const MAX_ITERATIONS = 32;
	while (changed && iterations < MAX_ITERATIONS) {
		changed = false;
		iterations++;
		for (const rule of rules) {
			const next = rule(current);
			if (next && next !== current) {
				current = next;
				changed = true;
			}
		}
	}
	return current;
}
