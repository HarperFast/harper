/**
 * PhysicalProject: per-row evaluation of the SELECT clause.
 *
 * Star expansion is preserved as-is — when the projection contains `*`, the
 * row is forwarded with its keys intact and the projected columns layered on
 * top. This keeps result shape compatible with the Resource API's natural
 * record shape.
 */

import type { ProjectionNode } from '../parser/ast.ts';
import type { PhysicalOp } from './op.ts';
import type { ColumnSchema, Row, SqlEngineContext } from '../types.ts';
import { compileExpr } from '../expressions/compile.ts';

export function physicalProject(child: PhysicalOp, projections: ProjectionNode[]): PhysicalOp {
	const slots = projections.map((p) => buildSlot(p));
	const schema: ColumnSchema[] = slots.flatMap((s) => s.schema);

	return {
		schema,
		async *execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			for await (const row of child.execute(ctx)) {
				const out: Row = {};
				for (const slot of slots) slot.apply(row, out);
				yield out;
			}
		},
	};
}

interface Slot {
	schema: ColumnSchema[];
	apply(row: Row, out: Row): void;
}

function buildSlot(p: ProjectionNode): Slot {
	if (p.expr.kind === 'star') {
		const tableQualifier = p.expr.table;
		return {
			schema: [],
			apply(row, out) {
				if (tableQualifier) {
					for (const k of Object.keys(row)) out[k] = row[k];
				} else {
					for (const k of Object.keys(row)) out[k] = row[k];
				}
			},
		};
	}
	const compiled = compileExpr(p.expr);
	const name = p.alias ?? expressionLabel(p);
	return {
		schema: [{ name, type: compiled.type, nullable: true }],
		apply(row, out) {
			out[name] = compiled.eval(row);
		},
	};
}

function expressionLabel(p: ProjectionNode): string {
	if (p.expr.kind === 'column') return p.expr.name;
	return p.alias ?? 'expr';
}
