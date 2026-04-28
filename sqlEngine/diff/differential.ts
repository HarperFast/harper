/**
 * Differential test harness.
 *
 * Runs a SQL query through both the legacy and new engines and deep-equals the
 * results modulo:
 *   - row order when no ORDER BY is present (sorted by JSON serialization),
 *   - undefined → null translation (legacy returns both; we normalize),
 *   - object key order.
 *
 * Used by the parity test suite under core/unitTests/sqlEngine/.
 */

import { EngineUnsupportedError } from '../errors.ts';

export interface DifferentialOptions {
	hdb_user?: unknown;
	preserveOrder?: boolean;
	bypass_auth?: boolean;
}

export interface DifferentialResult {
	legacy: unknown;
	v2: unknown;
	equal: boolean;
	v2Unsupported?: string;
}

interface SqlTranslator {
	evaluateSQL: (
		jsonMessage: Record<string, unknown>,
		callback: (err: unknown, data?: unknown) => void
	) => void;
}

function loadLegacy(): SqlTranslator {
	return require('../../sqlTranslator/index.js');
}

function runLegacy(sql: string, opts: DifferentialOptions): Promise<unknown> {
	const translator = loadLegacy();
	return new Promise((resolve, reject) => {
		translator.evaluateSQL(
			{ sql, hdb_user: opts.hdb_user, bypass_auth: opts.bypass_auth ?? true },
			(err: unknown, data: unknown) => {
				if (err) reject(err);
				else resolve(data);
			}
		);
	});
}

async function runV2(sql: string, opts: DifferentialOptions): Promise<unknown> {
	const previous = process.env.HARPER_SQL_ENGINE;
	process.env.HARPER_SQL_ENGINE = 'new';
	try {
		return await runLegacy(sql, opts);
	} finally {
		if (previous === undefined) delete process.env.HARPER_SQL_ENGINE;
		else process.env.HARPER_SQL_ENGINE = previous;
	}
}

function normalize(value: unknown): unknown {
	if (value === undefined) return null;
	if (value === null) return null;
	if (Array.isArray(value)) return value.map(normalize);
	if (typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value as Record<string, unknown>).sort()) {
			out[k] = normalize((value as Record<string, unknown>)[k]);
		}
		return out;
	}
	return value;
}

function sortRows(rows: unknown): unknown {
	if (!Array.isArray(rows)) return rows;
	return [...rows].sort((a, b) => {
		const sa = JSON.stringify(a);
		const sb = JSON.stringify(b);
		return sa < sb ? -1 : sa > sb ? 1 : 0;
	});
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

export async function runDifferential(sql: string, opts: DifferentialOptions = {}): Promise<DifferentialResult> {
	const legacy = await runLegacy(sql, opts);
	let v2: unknown;
	let v2Unsupported: string | undefined;
	try {
		v2 = await runV2(sql, opts);
	} catch (err) {
		if (err instanceof EngineUnsupportedError) {
			return { legacy, v2: undefined, equal: false, v2Unsupported: err.reason };
		}
		throw err;
	}

	const normalizedLegacy = normalize(legacy);
	const normalizedV2 = normalize(v2);
	const a = opts.preserveOrder ? normalizedLegacy : sortRows(normalizedLegacy);
	const b = opts.preserveOrder ? normalizedV2 : sortRows(normalizedV2);
	return { legacy, v2, equal: deepEqual(a, b), v2Unsupported };
}
