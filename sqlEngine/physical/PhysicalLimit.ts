/**
 * PhysicalLimit: drops `offset` rows then yields up to `limit` rows.
 */

import type { PhysicalOp } from './op.ts';
import type { Row, SqlEngineContext } from '../types.ts';

export function physicalLimit(child: PhysicalOp, limit: number | undefined, offset: number | undefined): PhysicalOp {
	return {
		schema: child.schema,
		async *execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			let skipped = 0;
			let yielded = 0;
			const skip = offset ?? 0;
			const cap = limit ?? Number.POSITIVE_INFINITY;
			for await (const row of child.execute(ctx)) {
				if (skipped < skip) {
					skipped++;
					continue;
				}
				if (yielded >= cap) return;
				yield row;
				yielded++;
			}
		},
	};
}
