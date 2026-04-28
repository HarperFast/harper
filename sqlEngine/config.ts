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
