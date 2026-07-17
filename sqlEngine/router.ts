/**
 * Router that dispatches a SQL request to either the new engine or the legacy
 * AlaSQL-based path based on the sql.engine config flag.
 *
 * 'legacy' — always run the legacy handler.
 * 'new'    — always run the new engine; if it throws EngineUnsupportedError,
 *            propagate that error (callers can catch).
 * 'auto'   — try the new engine; on EngineUnsupportedError, fall back to
 *            legacy and log the fallback.
 *
 * The router preserves the legacy entry's (statement, callback) signature so
 * core/sqlTranslator/index.js can plug it in without other changes.
 */

import { EngineUnsupportedError } from './errors.ts';
import { getSqlEngineConfig } from './config.ts';
import { runStatement } from './index.ts';

export type SqlVariant = 'select' | 'insert' | 'update' | 'delete';

export type LegacyHandler = (statement: unknown, callback: (err: unknown, data?: unknown) => void) => void;

export interface RouteOptions {
	variant: SqlVariant;
	jsonMessage: { hdb_user?: unknown; sql?: string; parsed_sql_object?: unknown };
	statement: unknown;
	legacy: LegacyHandler;
}

function getLogger(): { info: (msg: string) => void; warn: (msg: string) => void } {
	try {
		const harperLogger = require('../utility/logging/harper_logger.js');
		return harperLogger.loggerWithTag ? harperLogger.loggerWithTag('sql-engine') : harperLogger;
	} catch {
		return { info: () => {}, warn: () => {} };
	}
}

export function route(opts: RouteOptions, callback: (err: unknown, data?: unknown) => void): void {
	const config = getSqlEngineConfig();

	if (config.engine === 'legacy') {
		opts.legacy(opts.statement, callback);
		return;
	}

	runStatement({
		variant: opts.variant,
		jsonMessage: opts.jsonMessage,
		statement: opts.statement,
	}).then(
		(result) => callback(null, result),
		(err: unknown) => {
			if (config.engine === 'auto' && err instanceof EngineUnsupportedError) {
				getLogger().info(`SQL engine v2 fallback: ${err.reason}`);
				opts.legacy(opts.statement, callback);
				return;
			}
			callback(err);
		}
	);
}
