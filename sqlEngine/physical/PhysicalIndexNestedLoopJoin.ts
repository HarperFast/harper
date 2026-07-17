/**
 * PhysicalIndexNestedLoopJoin: streams the outer (left) input and, for each
 * outer row, probes the inner table via Table.search on its indexed join key.
 *
 * This is the default join strategy when the inner join key is indexed: no full
 * inner scan, bounded memory (one inner result set at a time), and it composes
 * with the inner table's own pushed-down WHERE conditions.
 *
 * The probe equality is ANDed with the inner scan's base conditions. Inner
 * records are filtered by the inner residual (bare names), then qualified with
 * the inner alias and merged with the outer row; an optional join residual (the
 * non-equi remainder of ON) is checked on the merged row. LEFT joins null-fill
 * the inner columns when no inner row matches.
 */

import type { ExprNode } from '../parser/ast.ts';
import type { PhysicalOp } from './op.ts';
import type { Row, SqlEngineContext } from '../types.ts';
import type { ConditionNode } from '../optimizer/whereToConditions.ts';
import { compileExpr } from '../expressions/compile.ts';

interface SearchableTable {
	search(target: unknown, context?: unknown): AsyncIterable<Row>;
}

export interface IndexNLJoinOptions {
	innerResource: unknown;
	innerAlias: string;
	/** Indexed inner attribute the probe equates against the outer key value. */
	innerAttribute: string;
	/** Outer-side join-key expression (compiled in qualified mode). */
	outerKey: ExprNode;
	/** Inner scan's own pushed-down conditions, ANDed with the probe equality. */
	innerBaseConditions: ConditionNode[];
	innerOperator: 'and' | 'or';
	innerSelect?: string[];
	/** Inner single-table residual (bare names), applied to probe records. */
	innerResidual?: ExprNode;
	/** Non-equi remainder of the ON clause (qualified), applied to merged rows. */
	residualOn?: ExprNode;
	type: 'inner' | 'left';
	rightNullKeys: string[];
}

export function physicalIndexNestedLoopJoin(left: PhysicalOp, opts: IndexNLJoinOptions): PhysicalOp {
	const resource = opts.innerResource as SearchableTable;
	const outerKeyEval = compileExpr(opts.outerKey, true).eval;
	const innerResidual = opts.innerResidual ? compileExpr(opts.innerResidual, false) : undefined;
	const residualOn = opts.residualOn ? compileExpr(opts.residualOn, true) : undefined;
	const prefix = `${opts.innerAlias}.`;

	return {
		schema: [],
		async *execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			for await (const outerRow of left.execute(ctx)) {
				const value = outerKeyEval(outerRow);
				let matched = false;
				if (value != null) {
					const target = buildProbeTarget(opts, value);
					for await (const innerRow of resource.search(target)) {
						if (innerResidual) {
							const v = innerResidual.eval(innerRow);
							if (v == null || v === false) continue;
						}
						const merged: Row = { ...outerRow };
						for (const k of Object.keys(innerRow)) merged[prefix + k] = innerRow[k];
						if (residualOn) {
							const v = residualOn.eval(merged);
							if (v == null || v === false) continue;
						}
						matched = true;
						yield merged;
					}
				}
				if (!matched && opts.type === 'left') {
					const out: Row = { ...outerRow };
					for (const k of opts.rightNullKeys) out[k] = null;
					yield out;
				}
			}
		},
	};
}

function buildProbeTarget(opts: IndexNLJoinOptions, value: unknown): Record<string, unknown> {
	const probe: ConditionNode = { attribute: opts.innerAttribute, value, comparator: 'equals' };
	let conditions: ConditionNode[];
	if (opts.innerBaseConditions.length === 0) {
		conditions = [probe];
	} else if (opts.innerOperator === 'and') {
		conditions = [...opts.innerBaseConditions, probe];
	} else {
		conditions = [{ conditions: opts.innerBaseConditions, operator: 'or' }, probe];
	}
	const target: Record<string, unknown> = { conditions, operator: 'and', allowFullScan: false };
	if (opts.innerSelect) target.select = opts.innerSelect;
	return target;
}
