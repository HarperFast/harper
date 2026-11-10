/**
 * PhysicalFilter: lazy residual filter on top of a child iterable.
 *
 * Keeps a row only when the predicate is TRUE (`compilePredicate`): FALSE,
 * NULL and every falsy value (0, NaN, '') drop it. Three-valued logic for the
 * predicate itself is handled inside compileExpr.
 */

import type { ExprNode } from '../parser/ast.ts';
import type { PhysicalOp } from './op.ts';
import type { Row, SqlEngineContext } from '../types.ts';
import { compilePredicate } from '../expressions/compile.ts';

export function physicalFilter(child: PhysicalOp, predicate: ExprNode, qualified = false): PhysicalOp {
	const passes = compilePredicate(predicate, qualified);
	return {
		schema: child.schema,
		async *execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			for await (const row of child.execute(ctx)) {
				if (passes(row)) yield row;
			}
		},
	};
}
