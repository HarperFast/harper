/**
 * Lowers a logical plan to a physical plan.
 *
 * Only the subset needed for phase 1 (single-table SELECT) is wired:
 *   Scan -> PhysicalIndexScan
 *   Filter -> PhysicalFilter
 *   Project -> PhysicalProject
 *   Sort -> PhysicalSort
 *   Limit -> PhysicalLimit
 *
 * Distinct, Aggregate, Join, Insert/Update/Delete are rejected with
 * EngineUnsupportedError until later phases.
 */

import type { LogicalPlan } from '../logical/op.ts';
import type { PhysicalOp } from './op.ts';
import type { ExprNode } from '../parser/ast.ts';
import { physicalIndexScan } from './PhysicalIndexScan.ts';
import { physicalFilter } from './PhysicalFilter.ts';
import { physicalProject } from './PhysicalProject.ts';
import { physicalSort } from './PhysicalSort.ts';
import { physicalLimit } from './PhysicalLimit.ts';
import { whereToConditions } from '../optimizer/whereToConditions.ts';
import { EngineUnsupportedError } from '../errors.ts';

export function compileToPhysical(plan: LogicalPlan): PhysicalOp {
	switch (plan.kind) {
		case 'Scan': {
			const { conditions, operator, residual } = whereToConditions(plan.pushedFilter);
			let op = physicalIndexScan(plan, { conditions, operator });
			const combinedResidual = mergeResidual(residual, plan.residualFilter);
			if (combinedResidual) op = physicalFilter(op, combinedResidual);
			return op;
		}
		case 'Filter':
			return physicalFilter(compileToPhysical(plan.input), plan.predicate);
		case 'Project':
			return physicalProject(compileToPhysical(plan.input), plan.projections);
		case 'Sort':
			return physicalSort(compileToPhysical(plan.input), plan.keys);
		case 'Limit':
			return physicalLimit(compileToPhysical(plan.input), plan.limit, plan.offset);
		case 'Distinct':
			throw new EngineUnsupportedError('DISTINCT is not supported in phase 1');
		case 'Aggregate':
			throw new EngineUnsupportedError('aggregate plan is not supported in phase 1');
		case 'Join':
			throw new EngineUnsupportedError('JOIN is not supported in phase 1');
		case 'Insert':
		case 'Update':
		case 'Delete':
			throw new EngineUnsupportedError('mutations are not supported in phase 1');
	}
}

function mergeResidual(a: ExprNode | undefined, b: ExprNode | undefined): ExprNode | undefined {
	if (!a) return b;
	if (!b) return a;
	return { kind: 'logical', op: 'and', args: [a, b] };
}
