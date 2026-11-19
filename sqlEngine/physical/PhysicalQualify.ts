/**
 * PhysicalQualify: re-keys a base scan's bare records into the join row model.
 *
 * In a join query every column flows through the pipeline under a
 * `<alias>.<attribute>` key so that same-named columns from different tables
 * never collide. The base PhysicalIndexScan yields plain records keyed by bare
 * attribute name (and Resource API conditions/projection operate on bare
 * names); this operator wraps that scan and qualifies every key with the
 * scan's alias. Residual single-table filters are applied *below* this operator
 * (in bare space) so only join-level operators see qualified rows.
 */

import type { PhysicalOp } from './op.ts';
import type { Row, SqlEngineContext } from '../types.ts';

export function physicalQualify(child: PhysicalOp, alias: string): PhysicalOp {
	const prefix = `${alias}.`;
	return {
		schema: child.schema,
		async *execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			for await (const row of child.execute(ctx)) {
				const out: Row = {};
				for (const k of Object.keys(row)) out[prefix + k] = row[k];
				yield out;
			}
		},
	};
}
