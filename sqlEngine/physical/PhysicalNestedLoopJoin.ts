/**
 * PhysicalNestedLoopJoin: the general join fallback for CROSS joins and
 * non-equi ON predicates that no hash/index strategy can serve.
 *
 * The right (inner) input is materialized once (bounded by maxHashRows); the
 * left (outer) input streams. For each left row every buffered right row is
 * tested against the compiled ON predicate (absent for CROSS) on the merged
 * row. LEFT joins null-fill the right columns when a left row matches nothing.
 *
 * Both inputs are already qualified (`<alias>.<attr>`); merge is a plain spread.
 */

import type { ExprNode } from '../parser/ast.ts';
import type { PhysicalOp } from './op.ts';
import type { Row, SqlEngineContext } from '../types.ts';
import { compileExpr } from '../expressions/compile.ts';
import { EngineRuntimeError } from '../errors.ts';

export interface NestedLoopJoinOptions {
	on?: ExprNode;
	type: 'inner' | 'left' | 'cross';
	rightNullKeys: string[];
	maxHashRows: number;
}

export function physicalNestedLoopJoin(left: PhysicalOp, right: PhysicalOp, opts: NestedLoopJoinOptions): PhysicalOp {
	const on = opts.on ? compileExpr(opts.on, true) : undefined;

	return {
		schema: [],
		async *execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			const inner: Row[] = [];
			for await (const rrow of right.execute(ctx)) {
				if (inner.length >= opts.maxHashRows) {
					throw new EngineRuntimeError(`nested-loop join inner side exceeded maxHashRows (${opts.maxHashRows})`);
				}
				inner.push(rrow);
			}

			for await (const lrow of left.execute(ctx)) {
				let matched = false;
				for (const rrow of inner) {
					const merged = { ...lrow, ...rrow };
					if (on) {
						const v = on.eval(merged);
						if (v == null || v === false) continue;
					}
					matched = true;
					yield merged;
				}
				if (!matched && opts.type === 'left') {
					const out: Row = { ...lrow };
					for (const k of opts.rightNullKeys) out[k] = null;
					yield out;
				}
			}
		},
	};
}
