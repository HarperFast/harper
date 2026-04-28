/**
 * PhysicalSort: in-memory sort with a configurable row cap.
 *
 * Used only when the optimizer's sort-from-index rule could not push the
 * sort into Table.search. Buffers up to maxSortRows rows; throws
 * EngineRuntimeError if the input exceeds that cap so callers fall back to
 * legacy or an explicit allowFullScan workflow.
 */

import type { SortNode } from '../parser/ast.ts';
import type { PhysicalOp } from './op.ts';
import type { Row, SqlEngineContext } from '../types.ts';
import { compileExpr } from '../expressions/compile.ts';
import { EngineRuntimeError } from '../errors.ts';
import { getSqlEngineConfig } from '../config.ts';

export function physicalSort(child: PhysicalOp, keys: SortNode[]): PhysicalOp {
	const compiled = keys.map((k) => ({ get: compileExpr(k.expr).eval, descending: k.descending }));
	return {
		schema: child.schema,
		async *execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			const cap = getSqlEngineConfig().maxSortRows;
			const buf: Row[] = [];
			for await (const row of child.execute(ctx)) {
				if (buf.length >= cap) {
					throw new EngineRuntimeError(`sort buffer exceeded ${cap} rows`);
				}
				buf.push(row);
			}
			buf.sort((a, b) => {
				for (const k of compiled) {
					const av = k.get(a);
					const bv = k.get(b);
					const cmp = compareValues(av, bv);
					if (cmp !== 0) return k.descending ? -cmp : cmp;
				}
				return 0;
			});
			for (const row of buf) yield row;
		},
	};
}

function compareValues(a: unknown, b: unknown): number {
	if (a == null && b == null) return 0;
	if (a == null) return -1;
	if (b == null) return 1;
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
	const as = String(a);
	const bs = String(b);
	return as < bs ? -1 : as > bs ? 1 : 0;
}
