/**
 * PhysicalDistinct: in-memory deduplication using a Set of JSON-serialised rows.
 *
 * Streaming: rows are yielded as they arrive; the Set grows until the iterator
 * is exhausted.  There is no row-count cap here — callers that need to bound
 * memory should reject DISTINCT on large inputs at the optimiser level.
 */

import type { Row, SqlEngineContext } from '../types.ts';
import type { PhysicalOp } from './op.ts';

export function physicalDistinct(input: PhysicalOp): PhysicalOp {
	return {
		schema: input.schema,
		execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			return dedup(input, ctx);
		},
	};
}

async function* dedup(input: PhysicalOp, ctx: SqlEngineContext): AsyncIterable<Row> {
	const seen = new Set<string>();
	for await (const row of input.execute(ctx)) {
		const key = JSON.stringify(row);
		if (!seen.has(key)) {
			seen.add(key);
			yield row;
		}
	}
}
