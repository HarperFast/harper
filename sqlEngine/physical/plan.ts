/**
 * Lowers a logical plan to a physical plan.
 *
 *   Scan      -> PhysicalIndexScan (+ residual PhysicalFilter); wrapped in
 *                PhysicalQualify for join queries so rows are keyed `alias.attr`.
 *   Filter    -> PhysicalFilter
 *   Project   -> PhysicalProject
 *   Sort      -> PhysicalSort
 *   Limit     -> PhysicalLimit
 *   Distinct  -> PhysicalDistinct
 *   Aggregate -> PhysicalHashAggregate
 *   Join      -> PhysicalIndexNestedLoopJoin | PhysicalHashJoin |
 *                PhysicalNestedLoopJoin (chosen by optimizer/rules/planJoins)
 *
 * `qualified` is computed once from whether the plan contains any Join and
 * threaded through every operator: join queries resolve columns by their
 * `<alias>.<attr>` key, single-table queries by bare name.
 *
 * Insert/Update/Delete are rejected until phase 4.
 */

import type { LogicalJoin, LogicalPlan, LogicalScan } from '../logical/op.ts';
import type { PhysicalOp } from './op.ts';
import type { ExprNode } from '../parser/ast.ts';
import { physicalIndexScan } from './PhysicalIndexScan.ts';
import { physicalFilter } from './PhysicalFilter.ts';
import { physicalProject } from './PhysicalProject.ts';
import { physicalSort } from './PhysicalSort.ts';
import { physicalLimit } from './PhysicalLimit.ts';
import { physicalHashAggregate } from './PhysicalHashAggregate.ts';
import { physicalDistinct } from './PhysicalDistinct.ts';
import { physicalQualify } from './PhysicalQualify.ts';
import { physicalHashJoin } from './PhysicalHashJoin.ts';
import { physicalNestedLoopJoin } from './PhysicalNestedLoopJoin.ts';
import { physicalIndexNestedLoopJoin } from './PhysicalIndexNestedLoopJoin.ts';
import { whereToConditions } from '../optimizer/whereToConditions.ts';
import { analyzeJoin, pickIndexedProbe } from '../optimizer/joinAnalysis.ts';
import { getSqlEngineConfig } from '../config.ts';
import { EngineUnsupportedError } from '../errors.ts';

export function compileToPhysical(plan: LogicalPlan): PhysicalOp {
	return lower(plan, planHasJoin(plan));
}

function lower(plan: LogicalPlan, qualified: boolean): PhysicalOp {
	switch (plan.kind) {
		case 'Scan': {
			const { conditions, operator, residual } = whereToConditions(plan.pushedFilter, plan.boundTable?.attributes);
			let op = physicalIndexScan(plan, { conditions, operator });
			const combinedResidual = mergeResidual(residual, plan.residualFilter);
			// Residual is single-table; compile it in bare space before qualifying.
			if (combinedResidual) op = physicalFilter(op, combinedResidual, false);
			if (qualified && plan.alias) op = physicalQualify(op, plan.alias);
			return op;
		}
		case 'Filter':
			return physicalFilter(lower(plan.input, qualified), plan.predicate, qualified);
		case 'Project':
			return physicalProject(lower(plan.input, qualified), plan.projections, qualified);
		case 'Sort':
			return physicalSort(lower(plan.input, qualified), plan.keys, qualified);
		case 'Limit':
			return physicalLimit(lower(plan.input, qualified), plan.limit, plan.offset);
		case 'Distinct':
			return physicalDistinct(lower(plan.input, qualified));
		case 'Aggregate': {
			const { maxHashRows } = getSqlEngineConfig();
			return physicalHashAggregate(lower(plan.input, qualified), plan.groupKeys, plan.aggs, maxHashRows, qualified);
		}
		case 'Join':
			return lowerJoin(plan);
		case 'Insert':
		case 'Update':
		case 'Delete':
			throw new EngineUnsupportedError('mutations are not supported until phase 4');
	}
}

function lowerJoin(join: LogicalJoin): PhysicalOp {
	const { maxHashRows } = getSqlEngineConfig();
	const analysis = analyzeJoin(join);
	if (!analysis) {
		throw new EngineUnsupportedError('join right side is not a single base table');
	}
	const left = lower(join.left, true);
	const rightNullKeys = qualifiedAttrKeys(analysis.rightScan);
	const joinType: 'inner' | 'left' = join.type === 'left' ? 'left' : 'inner';

	if (join.strategy === 'indexNL') {
		const probe = pickIndexedProbe(analysis);
		if (!probe) throw new EngineUnsupportedError('indexNL join lost its indexed probe key');
		const inner = analysis.rightScan;
		const { conditions, operator, residual } = whereToConditions(inner.pushedFilter, inner.boundTable?.attributes);
		const innerResidual = mergeResidual(residual, inner.residualFilter);
		// Equi-pairs other than the probe + non-equi ON remainder → merged-row residual.
		const otherEqui = analysis.equiPairs
			.filter((p) => p !== probe.pair)
			.map((p): ExprNode => ({ kind: 'binop', op: '=', left: p.outer, right: p.inner }));
		const residualOn = mergeAll([...otherEqui, ...(analysis.residualOn ? [analysis.residualOn] : [])]);
		return physicalIndexNestedLoopJoin(left, {
			innerResource: inner.boundTable?.resource,
			innerAlias: analysis.rightAlias,
			innerAttribute: probe.attribute,
			outerKey: probe.pair.outer,
			innerBaseConditions: conditions,
			innerOperator: operator,
			innerSelect: inner.projection,
			innerResidual,
			residualOn,
			type: joinType,
			rightNullKeys,
		});
	}

	const right = lower(join.right, true);

	if (join.strategy === 'hash') {
		return physicalHashJoin(left, right, {
			leftKeys: analysis.equiPairs.map((p) => p.outer),
			rightKeys: analysis.equiPairs.map((p) => p.inner),
			residual: analysis.residualOn,
			type: joinType,
			rightNullKeys,
			maxHashRows,
		});
	}

	// nestedLoop (CROSS / non-equi)
	return physicalNestedLoopJoin(left, right, {
		on: join.on,
		type: join.type === 'left' ? 'left' : join.type === 'cross' ? 'cross' : 'inner',
		rightNullKeys,
		maxHashRows,
	});
}

function qualifiedAttrKeys(scan: LogicalScan): string[] {
	const alias = scan.alias ?? '';
	return (scan.boundTable?.attributes ?? []).map((a) => `${alias}.${a.name}`);
}

function planHasJoin(plan: LogicalPlan): boolean {
	if (plan.kind === 'Join') return true;
	if ('input' in plan) return planHasJoin(plan.input);
	return false;
}

function mergeResidual(a: ExprNode | undefined, b: ExprNode | undefined): ExprNode | undefined {
	if (!a) return b;
	if (!b) return a;
	return { kind: 'logical', op: 'and', args: [a, b] };
}

function mergeAll(exprs: ExprNode[]): ExprNode | undefined {
	if (exprs.length === 0) return undefined;
	if (exprs.length === 1) return exprs[0];
	return { kind: 'logical', op: 'and', args: exprs };
}
