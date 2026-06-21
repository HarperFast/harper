/**
 * PhysicalIndexScan: wraps Table.search.
 *
 * Builds the RequestTarget from the LogicalScan's pushed filters/sort/limit
 * and projection, then yields rows from the returned AsyncIterable.
 */

import type { LogicalScan } from '../logical/op.ts';
import type { Row, SqlEngineContext } from '../types.ts';
import type { ColumnSchema } from '../types.ts';
import type { PhysicalOp } from './op.ts';
import type { ConditionNode } from '../optimizer/whereToConditions.ts';

interface SearchableTable {
	search(target: unknown, context?: unknown): AsyncIterable<Row>;
}

export interface PhysicalIndexScanOptions {
	conditions: ConditionNode[];
	operator: 'and' | 'or';
}

export function physicalIndexScan(scan: LogicalScan, opts: PhysicalIndexScanOptions): PhysicalOp {
	const schema: ColumnSchema[] = (scan.boundTable?.attributes ?? []).map((a) => ({
		name: a.name,
		type: 'unknown',
		nullable: true,
	}));

	return {
		schema,
		execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			return executeScan(scan, opts, ctx);
		},
	};
}

async function* executeScan(
	scan: LogicalScan,
	opts: PhysicalIndexScanOptions,
	_ctx: SqlEngineContext
): AsyncIterable<Row> {
	const resource = scan.boundTable?.resource as SearchableTable | undefined;
	if (!resource) throw new Error('PhysicalIndexScan: scan has no boundTable.resource');

	const target: Record<string, unknown> = { allowFullScan: false };
	// Only attach conditions/operator when there is at least one — Table.search
	// rejects an empty `and`/`or` group ("requires at least one condition"). A
	// scan with no conditions is driven by its pushed sort/limit alone.
	if (opts.conditions.length > 0) {
		target.conditions = opts.conditions;
		target.operator = opts.operator;
	}
	if (scan.projection) target.select = scan.projection;
	if (scan.pushedSort && scan.pushedSort.length > 0) {
		const k = scan.pushedSort[0];
		if (k.expr.kind === 'column') {
			target.sort = { attribute: k.expr.name, descending: k.descending };
		}
	}
	if (scan.pushedLimit) {
		if (scan.pushedLimit.limit != null) target.limit = scan.pushedLimit.limit;
		if (scan.pushedLimit.offset != null) target.offset = scan.pushedLimit.offset;
	}

	for await (const row of resource.search(target)) {
		yield row;
	}
}
