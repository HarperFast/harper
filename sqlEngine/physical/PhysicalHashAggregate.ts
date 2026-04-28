/**
 * PhysicalHashAggregate: groups all input rows in a Map keyed on JSON-serialised
 * group-key values, then finalises accumulators and yields one output row per
 * group.
 *
 * Memory is bounded by maxHashRows (total input rows consumed), after which an
 * EngineRuntimeError is thrown.
 *
 * Special cases:
 *  - No GROUP BY + no rows  → emit one row with default aggregate values
 *    (e.g. COUNT(*) = 0).
 *  - COUNT(*) arg is a star placeholder; we pass the sentinel value 1 to step()
 *    so the accumulator counts every row unconditionally.
 */

import type { ExprNode } from '../parser/ast.ts';
import type { Row, SqlEngineContext } from '../types.ts';
import type { PhysicalOp } from './op.ts';
import type { AggFn, Accumulator } from '../functions/registry.ts';
import { compileExpr } from '../expressions/compile.ts';
import { functionRegistry } from '../functions/registry.ts';
import { EngineUnsupportedError, EngineRuntimeError } from '../errors.ts';

export interface AggOpSpec {
	name: string;
	arg: ExprNode | { kind: 'star' };
	outputName: string;
	distinct?: boolean;
}

interface CompiledAgg {
	outputName: string;
	factory: () => Accumulator;
	isStarArg: boolean;
	argEval: ((row: Row) => unknown) | null;
}

export function physicalHashAggregate(
	input: PhysicalOp,
	groupKeys: ExprNode[],
	aggs: AggOpSpec[],
	maxHashRows: number,
): PhysicalOp {
	// Compile up-front so errors are surfaced at plan time, not per-row.
	const groupKeyEvals = groupKeys.map((k) => {
		if (k.kind !== 'column') throw new EngineUnsupportedError('GROUP BY supports only column refs', k);
		return (row: Row): unknown => row[k.name];
	});
	const groupKeyNames = groupKeys.map((k) => (k as { kind: 'column'; name: string }).name);

	const compiledAggs: CompiledAgg[] = aggs.map((a) => {
		const desc = functionRegistry.lookup(a.name);
		if (!desc || desc.kind !== 'aggregate') {
			throw new EngineUnsupportedError(`unknown aggregate function: ${a.name}`);
		}
		const isStarArg = a.arg.kind === 'star';
		const argEval = isStarArg ? null : compileExpr(a.arg as ExprNode).eval;
		return {
			outputName: a.outputName,
			factory: (desc.impl as AggFn).factory,
			isStarArg,
			argEval,
		};
	});

	return {
		schema: [],
		execute(ctx: SqlEngineContext): AsyncIterable<Row> {
			return runAggregate(input, ctx, groupKeyEvals, groupKeyNames, compiledAggs, maxHashRows);
		},
	};
}

async function* runAggregate(
	input: PhysicalOp,
	ctx: SqlEngineContext,
	groupKeyEvals: Array<(row: Row) => unknown>,
	groupKeyNames: string[],
	compiledAggs: CompiledAgg[],
	maxHashRows: number,
): AsyncIterable<Row> {
	type Entry = { keys: unknown[]; accs: Accumulator[] };
	const groups = new Map<string, Entry>();
	let rowCount = 0;

	for await (const row of input.execute(ctx)) {
		if (++rowCount > maxHashRows) {
			throw new EngineRuntimeError(`aggregate exceeded maxHashRows limit (${maxHashRows})`);
		}
		const keyVals = groupKeyEvals.map((fn) => fn(row));
		const groupKey = JSON.stringify(keyVals);

		let entry = groups.get(groupKey);
		if (!entry) {
			entry = { keys: keyVals, accs: compiledAggs.map((a) => a.factory()) };
			groups.set(groupKey, entry);
		}

		for (let i = 0; i < compiledAggs.length; i++) {
			const agg = compiledAggs[i];
			const val = agg.isStarArg ? 1 : agg.argEval!(row);
			entry.accs[i].step(val);
		}
	}

	// No GROUP BY + no rows → emit one row with zero/null aggregate values.
	if (groups.size === 0 && groupKeyNames.length === 0) {
		const outputRow: Row = {};
		for (const agg of compiledAggs) {
			outputRow[agg.outputName] = agg.factory().finalize();
		}
		yield outputRow;
		return;
	}

	for (const { keys, accs } of groups.values()) {
		const outputRow: Row = {};
		for (let i = 0; i < groupKeyNames.length; i++) {
			outputRow[groupKeyNames[i]] = keys[i];
		}
		for (let i = 0; i < compiledAggs.length; i++) {
			outputRow[compiledAggs[i].outputName] = accs[i].finalize();
		}
		yield outputRow;
	}
}
