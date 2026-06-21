/**
 * Reads the SQL engine feature flag and runtime caps.
 *
 * sql.engine selects which engine handles a SQL request:
 *   'legacy' — existing AlaSQL-based path (default).
 *   'new'    — new Resource-API-based path; throws EngineUnsupportedError for
 *              queries it can't plan.
 *   'auto'   — try the new path first; fall back to legacy on
 *              EngineUnsupportedError.
 *
 * The flag is read from the HARPER_SQL_ENGINE environment variable, then
 * harperConfig.sql?.engine, then defaults to 'legacy'. We deliberately keep
 * this resolution lazy and lightweight so the router can be invoked without a
 * fully booted Harper config (e.g., in unit tests).
 *
 * Phase 5 cutover: default stays 'legacy' until full parity. A trial flip to
 * 'auto' surfaced two blockers via the existing SQL suite (see PLAN.md phase-5
 * notes): (1) literal type-coercion on hash lookups — `id IN ('123')` against a
 * numeric PK matches in legacy but not the new engine (a SILENT wrong-result, the
 * dangerous kind that 'auto' does not fall back on); (2) a `LIKE`-predicate DELETE
 * returning 403 through the new selector path. Fix those before flipping.
 */

export type SqlEngineMode = 'legacy' | 'new' | 'auto';

export interface SqlEngineConfig {
	engine: SqlEngineMode;
	allowFullScan: boolean;
	maxSortRows: number;
	maxHashRows: number;
}

const DEFAULTS: SqlEngineConfig = {
	engine: 'legacy',
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
