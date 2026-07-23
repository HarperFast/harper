/**
 * Physical operator interface.
 *
 * Volcano-style with AsyncIterable. Each operator's execute() yields rows
 * lazily; backpressure is implicit in `await`.
 */

import type { ColumnSchema, Row, SqlEngineContext } from '../types.ts';

export interface PhysicalOp {
	schema: ColumnSchema[];
	execute(ctx: SqlEngineContext): AsyncIterable<Row>;
}
