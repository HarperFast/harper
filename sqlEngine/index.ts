/**
 * Public entry point of the new SQL engine.
 *
 * The legacy SQL translator (core/sqlTranslator/index.js) routes SELECT/
 * INSERT/UPDATE/DELETE through router.ts; in 'new' or 'auto' mode the router
 * calls runStatement here.
 *
 * Phase 0: every request throws EngineUnsupportedError so 'auto' mode falls
 * back to legacy and 'new' mode rejects loudly. Phases 1–4 incrementally fill
 * in normalize → bind → build → optimize → physical → execute.
 */

import { normalizeStatement } from './parser/normalizer.ts';
import { bind } from './binder/bind.ts';
import type { BoundInsert, BoundUpdate, BoundDelete } from './binder/bind.ts';
import { buildLogicalPlan } from './logical/build.ts';
import { compileToPhysical } from './physical/plan.ts';
import { runSelect } from './executor/runSelect.ts';
import { runInsert, runUpdate, runDelete } from './executor/runMutation.ts';
import { optimize } from './optimizer/optimize.ts';
import { registerStandardFunctions } from './functions/standard.ts';
import { registerAggregateFunctions } from './functions/aggregates.ts';

export interface RunStatementInput {
	variant: 'select' | 'insert' | 'update' | 'delete';
	jsonMessage: { hdb_user?: unknown; parsed_sql_object?: unknown };
	statement: unknown;
}

export async function runStatement(input: RunStatementInput): Promise<unknown> {
	registerStandardFunctions();
	registerAggregateFunctions();

	const ctx = { user: input.jsonMessage.hdb_user };
	const ir = normalizeStatement(input.statement as Record<string, unknown>, input.variant);
	const bound = bind(ir, ctx);

	switch (bound.kind) {
		case 'insert':
			return runInsert(bound as BoundInsert, ctx);
		case 'update':
			return runUpdate(bound as BoundUpdate, ctx);
		case 'delete':
			return runDelete(bound as BoundDelete, ctx);
		default: {
			const physical = compileToPhysical(optimize(buildLogicalPlan(bound)));
			return runSelect(physical, ctx);
		}
	}
}

// Re-export the surface modules so a single import covers the engine boundary.
export { normalizeStatement, bind, buildLogicalPlan, compileToPhysical, runSelect };
export { EngineUnsupportedError, EngineRuntimeError } from './errors.ts';
export { getSqlEngineConfig } from './config.ts';
export type { SqlEngineMode } from './config.ts';
