/**
 * PhysicalProject: per-row evaluation of the SELECT clause.
 *
 * Single-table (`qualified = false`): star expansion forwards the row's keys
 * intact and layers projected columns on top, matching the Resource API's
 * natural record shape.
 *
 * Join queries (`qualified = true`): rows arrive keyed by `<alias>.<name>`.
 * Output columns are renamed to clean, unqualified names (or the SELECT `AS`
 * alias). When two output columns collide on the same name the later one is
 * suffixed `_2`, `_3`, … in SELECT order (legacy AlaSQL instead emitted
 * `[name]`/`[name1]`; the differential harness normalizes between the two).
 * `SELECT *` expands every column across all joined tables; `SELECT t.*`
 * expands only table `t`'s columns.
 */

import type { ProjectionNode } from '../parser/ast.ts';
import type { PhysicalOp } from './op.ts';
import type { ColumnSchema, Row, SqlEngineContext } from '../types.ts';
import { compileExpr } from '../expressions/compile.ts';

export function physicalProject(child: PhysicalOp, projections: ProjectionNode[], qualified = false): PhysicalOp {
	if (qualified) return qualifiedProject(child, projections);

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
		return {
			schema: [],
			apply(row, out) {
				for (const k of Object.keys(row)) out[k] = row[k];
			},
		};
	}
	const compiled = compileExpr(p.expr);
	const name = p.alias ?? p.label ?? expressionLabel(p);
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

// ---------------------------------------------------------------------------
// Join (qualified) projection
// ---------------------------------------------------------------------------

interface QualifiedSlot {
	/** Push [name, value] pairs (pre-dedup) for this projection onto `acc`. */
	emit(row: Row, acc: Array<[string, unknown]>): void;
}

function qualifiedProject(child: PhysicalOp, projections: ProjectionNode[]): PhysicalOp {
	const slots: QualifiedSlot[] = projections.map((p) => buildQualifiedSlot(p));

	return {
		schema: [],
		async *execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			for await (const row of child.execute(ctx)) {
				const pairs: Array<[string, unknown]> = [];
				for (const slot of slots) slot.emit(row, pairs);
				yield dedupeIntoRow(pairs);
			}
		},
	};
}

function buildQualifiedSlot(p: ProjectionNode): QualifiedSlot {
	if (p.expr.kind === 'star') {
		const prefix = p.expr.table ? `${p.expr.table}.` : undefined;
		return {
			emit(row, acc) {
				for (const k of Object.keys(row)) {
					if (prefix) {
						if (k.startsWith(prefix)) acc.push([k.slice(prefix.length), row[k]]);
					} else {
						// strip the alias qualifier for clean output
						const dot = k.indexOf('.');
						acc.push([dot >= 0 ? k.slice(dot + 1) : k, row[k]]);
					}
				}
			},
		};
	}
	const compiled = compileExpr(p.expr, true);
	const name = p.alias ?? p.label ?? qualifiedLabel(p);
	return {
		emit(row, acc) {
			acc.push([name, compiled.eval(row)]);
		},
	};
}

function qualifiedLabel(p: ProjectionNode): string {
	if (p.expr.kind === 'column') return p.expr.name; // bare name, alias dropped
	return p.alias ?? 'expr';
}

function dedupeIntoRow(pairs: Array<[string, unknown]>): Row {
	const out: Row = {};
	const counts = new Map<string, number>();
	for (const [name, value] of pairs) {
		const n = counts.get(name) ?? 0;
		counts.set(name, n + 1);
		out[n === 0 ? name : `${name}_${n + 1}`] = value;
	}
	return out;
}
