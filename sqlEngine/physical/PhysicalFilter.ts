/**
 * PhysicalFilter: lazy residual filter on top of a child iterable.
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
