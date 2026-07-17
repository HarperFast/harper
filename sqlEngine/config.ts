/**
 * Reads the SQL engine feature flag and runtime caps.
 *
 * sql.engine selects which engine handles a SQL request:
 *   'legacy' — existing AlaSQL-based path.
 *   'new'    — new Resource-API-based path; throws EngineUnsupportedError for
 *              queries it can't plan.
 *   'auto'   — try the new path first; fall back to legacy on
 *              EngineUnsupportedError (default).
 *
 * The flag is read from the HARPER_SQL_ENGINE environment variable, then
 * harperConfig.sql?.engine, then defaults to 'auto'. We deliberately keep
 * this resolution lazy and lightweight so the router can be invoked without a
 * fully booted Harper config (e.g., in unit tests).
 *
 * Phase 5 cutover: the default is now 'auto' — the new engine handles every SQL
 * request it can plan and silently falls back to legacy on anything it can't, so
 * no query changes behavior unless the new engine produces an identical result.
 * The gate for this flip was full parity of the new engine (run in 'auto') against
 * the existing SQL suite: the cutover-readiness differential (46/46 identical) plus
 * the existing behavioral suites under 'auto' — northwind (575 SQL ops) and
 * delete.test.mjs (76) — at 0 failures. Both trial-flip blockers (IN literal
 * coercion, LIKE-predicate DELETE 403) and the northwind gaps (attribute-name
 * validation, quoted-boolean coercion, != / NULL three-valued logic) are fixed.
 * The remaining cutover work is burn-in (watch `sql-engine v2 fallback:` logs) then
 * flipping to 'new' and deleting the legacy path. See PLAN.md phase-5 notes.
 */

export type SqlEngineMode = 'legacy' | 'new' | 'auto';

export interface SqlEngineConfig {
	engine: SqlEngineMode;
	allowFullScan: boolean;
	maxSortRows: number;
	maxHashRows: number;
}

const DEFAULTS: SqlEngineConfig = {
	engine: 'auto',
	allowFullScan: false,
	maxSortRows: 1_000_000,
	maxHashRows: 1_000_000,
};

function envEngine(): SqlEngineMode | undefined {
	const v = process.env.HARPER_SQL_ENGINE;
	if (v === 'legacy' || v === 'new' || v === 'auto') return v;
	return undefined;
}

function harperConfigEngine(): Partial<SqlEngineConfig> {
	try {
		const harperConfig = (globalThis as { harperConfig?: { sql?: Partial<SqlEngineConfig> } }).harperConfig;
		return harperConfig?.sql ?? {};
	} catch {
		return {};
	}
}

export function getSqlEngineConfig(): SqlEngineConfig {
	const fromConfig = harperConfigEngine();
	const fromEnv = envEngine();
	return {
		engine: fromEnv ?? fromConfig.engine ?? DEFAULTS.engine,
		allowFullScan: fromConfig.allowFullScan ?? DEFAULTS.allowFullScan,
		maxSortRows: fromConfig.maxSortRows ?? DEFAULTS.maxSortRows,
		maxHashRows: fromConfig.maxHashRows ?? DEFAULTS.maxHashRows,
	};
}
