/**
 * PhysicalHashJoin: equi-join via an in-memory hash table on the right (inner)
 * side.
 *
 * Build phase materializes the right input into a Map keyed on the JSON-encoded
 * join-key tuple (bounded by maxHashRows). Probe phase streams the left
 * (outer) input, looks up each left row's key tuple, and emits the merged row
 * for every matching right row. An optional `residual` predicate (the
 * non-equi remainder of the ON clause) is checked on the merged row.
 *
 * For a LEFT join, a left row with no surviving match emits once with the right
 * side's declared columns null-filled (matching legacy `undefined → null`
 * outer-join semantics in dataLayer/SQLSearch).
 *
 * Rows on both sides are already qualified (`<alias>.<attr>`), so the merge is
 * a plain spread with no key collisions.
 */

import type { ExprNode } from '../parser/ast.ts';
import type { PhysicalOp } from './op.ts';
import type { Row, SqlEngineContext } from '../types.ts';
import { compileExpr } from '../expressions/compile.ts';
import { EngineUnsupportedError } from '../errors.ts';

export interface HashJoinOptions {
	leftKeys: ExprNode[];
	rightKeys: ExprNode[];
	residual?: ExprNode;
	type: 'inner' | 'left';
	/** Right-side qualified keys to null-fill on unmatched LEFT rows. */
	rightNullKeys: string[];
	maxHashRows: number;
}

export function physicalHashJoin(left: PhysicalOp, right: PhysicalOp, opts: HashJoinOptions): PhysicalOp {
	const leftKeyEvals = opts.leftKeys.map((e) => compileExpr(e, true).eval);
	const rightKeyEvals = opts.rightKeys.map((e) => compileExpr(e, true).eval);
	const residual = opts.residual ? compileExpr(opts.residual, true) : undefined;

	return {
		schema: [],
		async *execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			// Build side: right input → Map<keyTuple, Row[]>.
			const buckets = new Map<string, Row[]>();
			let built = 0;
			for await (const rrow of right.execute(ctx)) {
				if (++built > opts.maxHashRows) {
					throw new EngineUnsupportedError(`hash join build side exceeded maxHashRows (${opts.maxHashRows})`);
				}
				const key = keyTuple(rightKeyEvals, rrow);
				if (key === undefined) continue; // NULL join key never matches
				const bucket = buckets.get(key);
				if (bucket) bucket.push(rrow);
				else buckets.set(key, [rrow]);
			}

			for await (const lrow of left.execute(ctx)) {
				const key = keyTuple(leftKeyEvals, lrow);
				let matched = false;
				if (key !== undefined) {
					const bucket = buckets.get(key);
					if (bucket) {
						for (const rrow of bucket) {
							const merged = { ...lrow, ...rrow };
							if (residual) {
								const v = residual.eval(merged);
								if (v == null || v === false) continue;
							}
							matched = true;
							yield merged;
						}
					}
				}
				if (!matched && opts.type === 'left') {
					yield nullFill(lrow, opts.rightNullKeys);
				}
			}
		},
	};
}

/**
 * Serializes the join key. Returns undefined if any key component is null/
 * undefined or NaN — SQL equi-joins never match on NULL, and NaN is never equal
 * to itself (without this guard JSON.stringify coerces NaN → "null", letting two
 * NaN keys collide and match).
 */
function keyTuple(evals: Array<(row: Row) => unknown>, row: Row): string | undefined {
	const vals: unknown[] = [];
	for (const e of evals) {
		const v = e(row);
		if (v == null || (typeof v === 'number' && Number.isNaN(v))) return undefined;
		vals.push(v);
	}
	return JSON.stringify(vals);
}

function nullFill(lrow: Row, rightNullKeys: string[]): Row {
	const out: Row = { ...lrow };
	for (const k of rightNullKeys) out[k] = null;
	return out;
}
