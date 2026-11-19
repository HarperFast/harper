/**
 * Join-strategy rule.
 *
 * Sets `LogicalJoin.strategy` and, for index-nested-loop joins, marks the inner
 * scan with `joinProbe` so validateScannable accepts it (it is served by an
 * indexed equality probe, not a standalone full scan).
 *
 * Strategy choice:
 *   - `indexNL`    — equi-join whose inner join key is an indexed column. The
 *                    inner table is probed once per outer row; no full scan.
 *   - `hash`       — equi-join without an indexed inner key. Reads the whole
 *                    inner side (allowed only if the inner scan is otherwise
 *                    index-served by its own WHERE, or allowFullScan is on).
 *   - `nestedLoop` — CROSS joins and non-equi ON predicates.
 *
 * (`relationship` — the declared-relationship fast path — is a later addition.)
 */

import type { LogicalJoin, LogicalPlan } from '../../logical/op.ts';
import { analyzeJoin, pickIndexedProbe } from '../joinAnalysis.ts';

export function planJoins(plan: LogicalPlan): LogicalPlan | null {
	let mutated = false;

	function walk(node: LogicalPlan): LogicalPlan {
		switch (node.kind) {
			case 'Join': {
				const left = walk(node.left);
				const right = walk(node.right);
				const next: LogicalJoin = { ...node, left, right };
				if (!next.strategy) {
					assignStrategy(next);
					mutated = true;
				}
				return next;
			}
			default:
				if ('input' in node) {
					const input = walk(node.input);
					return input === node.input ? node : { ...node, input };
				}
				return node;
		}
	}

	const result = walk(plan);
	return mutated ? result : null;
}

function assignStrategy(join: LogicalJoin): void {
	const analysis = analyzeJoin(join);
	if (!analysis || analysis.equiPairs.length === 0) {
		join.strategy = 'nestedLoop';
		return;
	}
	const probe = pickIndexedProbe(analysis);
	if (probe) {
		join.strategy = 'indexNL';
		analysis.rightScan.joinProbe = { keyAttribute: probe.attribute };
	} else {
		join.strategy = 'hash';
	}
}
