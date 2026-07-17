/**
 * PhysicalFilter: lazy residual filter on top of a child iterable.
 *
 * Drops rows when the compiled predicate evaluates to anything other than
 * truthy (`null`/`undefined`/`false`). Three-valued logic for the predicate
 * itself is handled inside compileExpr.
 */

import type { ExprNode } from '../parser/ast.ts';
import type { PhysicalOp } from './op.ts';
import type { Row, SqlEngineContext } from '../types.ts';
import { compileExpr } from '../expressions/compile.ts';

export function physicalFilter(child: PhysicalOp, predicate: ExprNode, qualified = false): PhysicalOp {
	const compiled = compileExpr(predicate, qualified);
	return {
		schema: child.schema,
		async *execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			for await (const row of child.execute(ctx)) {
				const v = compiled.eval(row);
				if (v != null && v !== false) yield row;
			}
		},
	};
}
