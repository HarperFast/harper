/**
 * Builds an unoptimized logical plan from a bound SELECT.
 *
 * The shape produced is:
 *
 *   Project
 *     -> (optional) Limit
 *       -> (optional) Sort
 *         -> (optional) Filter         // WHERE
 *           -> Scan                    // FROM
 *
 * Optimizer rules later push Filter into Scan.pushedFilter, push Sort into
 * Scan.pushedSort, push Limit into Scan.pushedLimit, and minimize the Project's
 * required attributes.
 */

import type { LogicalPlan, LogicalScan } from './op.ts';
import type { SelectNode, StatementNode } from '../parser/ast.ts';
import type { BoundSelect } from '../binder/bind.ts';
import { EngineUnsupportedError } from '../errors.ts';

export function buildLogicalPlan(stmt: StatementNode): LogicalPlan {
	if (stmt.kind !== 'select') {
		throw new EngineUnsupportedError(`logical/build: only SELECT supported in phase 1, got ${stmt.kind}`);
	}
	return buildSelect(stmt as SelectNode & Partial<BoundSelect>);
}

function buildSelect(stmt: SelectNode & Partial<BoundSelect>): LogicalPlan {
	const scan: LogicalScan = {
		kind: 'Scan',
		table: stmt.from,
		boundTable: stmt.boundTable,
	};

	let plan: LogicalPlan = scan;

	if (stmt.where) {
		plan = { kind: 'Filter', input: plan, predicate: stmt.where };
	}

	if (stmt.orderBy && stmt.orderBy.length > 0) {
		plan = { kind: 'Sort', input: plan, keys: stmt.orderBy };
	}

	if (stmt.limit != null || stmt.offset != null) {
		plan = { kind: 'Limit', input: plan, limit: stmt.limit, offset: stmt.offset };
	}

	plan = { kind: 'Project', input: plan, projections: stmt.projections };

	if (stmt.distinct) {
		plan = { kind: 'Distinct', input: plan };
	}

	return plan;
}
