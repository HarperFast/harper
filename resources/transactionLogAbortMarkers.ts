import { RocksDatabase } from '@harperfast/rocksdb-js';
import { getEnvironmentData, isMainThread, setEnvironmentData } from 'node:worker_threads';

const MARKERS_KEY = 'harper.transactionLogAbortMarkers';
const INTENTS_KEY = 'harper.transactionLogWriteIntents';
let markers = getEnvironmentData(MARKERS_KEY) as boolean | undefined;
let intents = getEnvironmentData(INTENTS_KEY) as boolean | undefined;

function isFalse(configured: unknown): boolean {
	if (configured === false || configured === 0) return true;
	return typeof configured === 'string' && ['false', '0', 'no', 'off'].includes(configured.trim().toLowerCase());
}

export function resolveAbortMarkersSetting(configured: unknown): boolean {
	return !isFalse(configured);
}

export function resolveWriteIntentsSetting(configured: unknown): boolean {
	if (configured === true || configured === 1) return true;
	return typeof configured === 'string' && ['true', '1', 'yes', 'on'].includes(configured.trim().toLowerCase());
}

/**
 * The values every RocksDB `config()` call passes. The native settings are process-global, so the main
 * thread's first resolution is handed to every worker it starts; a later change needs a restart.
 */
export function latchAbortMarkers(configured: unknown): boolean {
	if (markers === undefined) {
		markers = resolveAbortMarkersSetting(configured);
		if (isMainThread) setEnvironmentData(MARKERS_KEY, markers);
	}
	return markers;
}

export function latchWriteIntents(configured: unknown): boolean {
	if (intents === undefined) {
		intents = resolveWriteIntentsSetting(configured);
		if (isMainThread) setEnvironmentData(INTENTS_KEY, intents);
	}
	return intents;
}

export function abortMarkersEnabled(): boolean {
	return markers === true;
}

/** Switches the process-global setting; only between tests, with no transaction open. Returns the prior value. */
export function setAbortMarkersForTests(enabled: boolean): boolean | undefined {
	const prior = markers;
	markers = enabled;
	RocksDatabase.config({ transactionLogAbortMarkers: enabled });
	return prior;
}

/** As `setAbortMarkersForTests`; `undefined` clears the latch, so the next database open resolves it from config. */
export function setWriteIntentsForTests(enabled: boolean | undefined): boolean | undefined {
	const prior = intents;
	intents = enabled;
	if (enabled !== undefined) RocksDatabase.config({ transactionLogWriteIntents: enabled });
	return prior;
}
