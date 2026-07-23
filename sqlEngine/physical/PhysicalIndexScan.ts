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
import { EngineUnsupportedError } from '../errors.ts';
import { ClientError, IndexRebuildingError } from '../../utility/errors/hdbError.ts';

interface SearchableTable {
	search(target: unknown, context?: unknown): AsyncIterable<Row>;
}

export interface PhysicalIndexScanOptions {
	conditions: ConditionNode[];
	operator: 'and' | 'or';
	/**
	 * Set for a sort-driven scan (no index-driving predicate; the pushed sort
	 * provides index order — D-219). Table.search flags a sort-aligned scan as
	 * needFullScan and would reject it under allowFullScan:false, so it must be
	 * allowed here. Validated as scannable by validateScannable, so this is not a
	 * blanket full-scan escape hatch.
	 */
	allowFullScan?: boolean;
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
	ctx: SqlEngineContext
): AsyncIterable<Row> {
	const resource = scan.boundTable?.resource as SearchableTable | undefined;
	if (!resource) throw new Error('PhysicalIndexScan: scan has no boundTable.resource');

	const target: Record<string, unknown> = { allowFullScan: opts.allowFullScan === true };
	if (ctx.includeExpiredRows) target.includeExpired = true;
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

	// Safety net for the fallback contract: validateScannable predicts what
	// Table.search will accept, but if the prediction is ever wrong (F-145: a
	// pushed `ne null` guard on an index without indexNulls), search throws a
	// capability-shaped ClientError (400/403/404) or IndexRebuildingError at
	// runtime, past the router's EngineUnsupportedError catch — leaking an error
	// where 'auto' should fall back. Convert those here; results are materialized
	// before delivery, so no partial rows have been sent when this fires.
	try {
		for await (const row of resource.search(target)) {
			yield row;
		}
	} catch (err) {
		if (err instanceof EngineUnsupportedError) throw err;
		if (err instanceof IndexRebuildingError) {
			throw new EngineUnsupportedError(`index rebuilding: ${err.message}`);
		}
		if (err instanceof ClientError) {
			throw new EngineUnsupportedError(`search rejected scan: ${err.message}`);
		}
		throw err;
	}
}
