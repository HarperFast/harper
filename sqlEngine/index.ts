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

import { EngineUnsupportedError } from './errors.ts';
import { normalizeStatement } from './parser/normalizer.ts';
import { bind } from './binder/bind.ts';
import { buildLogicalPlan } from './logical/build.ts';
import { compileToPhysical } from './physical/plan.ts';
import { runSelect } from './executor/runSelect.ts';
import { optimize } from './optimizer/optimize.ts';
import { registerStandardFunctions } from './functions/standard.ts';

export interface RunStatementInput {
	variant: 'select' | 'insert' | 'update' | 'delete';
	jsonMessage: { hdb_user?: unknown; parsed_sql_object?: unknown };
	statement: unknown;
}

export async function runStatement(input: RunStatementInput): Promise<unknown> {
	registerStandardFunctions();

	if (input.variant !== 'select') {
		throw new EngineUnsupportedError(`${input.variant} is not implemented yet (phase 1: select only)`);
	}

	const ir = normalizeStatement(input.statement as Record<string, unknown>, input.variant);
	const bound = bind(ir, { user: input.jsonMessage.hdb_user });
	const logical = buildLogicalPlan(bound);
	const optimized = optimize(logical);
	const physical = compileToPhysical(optimized);
	return runSelect(physical, { user: input.jsonMessage.hdb_user });
}

// Re-export the surface modules so a single import covers the engine boundary.
export { normalizeStatement, bind, buildLogicalPlan, compileToPhysical, runSelect };
export { EngineUnsupportedError, EngineRuntimeError } from './errors.ts';
export { getSqlEngineConfig } from './config.ts';
export type { SqlEngineMode } from './config.ts';
