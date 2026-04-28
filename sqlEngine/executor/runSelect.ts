/**
 * Drives the root iterator for a SELECT plan and shapes the result.
 * Phase 0 stub.
 */

import type { PhysicalOp } from '../physical/op.ts';
import type { Row, SqlEngineContext } from '../types.ts';

export async function runSelect(plan: PhysicalOp, ctx: SqlEngineContext): Promise<Row[]> {
	const out: Row[] = [];
	for await (const row of plan.execute(ctx)) out.push(row);
	return out;
}
