import { RocksDatabase } from '@harperfast/rocksdb-js';
import { getEnvironmentData, isMainThread, setEnvironmentData } from 'node:worker_threads';

const LATCH_KEY = 'harper.transactionLogAbortMarkers';
let latched = getEnvironmentData(LATCH_KEY) as boolean | undefined;

export function resolveAbortMarkersSetting(configured: unknown): boolean {
	if (configured === false || configured === 0) return false;
	if (typeof configured === 'string') return !['false', '0', 'no', 'off'].includes(configured.trim().toLowerCase());
	return true;
}

/**
 * The value every RocksDB `config()` call passes. The native setting is process-global, so the main
 * thread's first resolution is handed to every worker it starts; a later change needs a restart.
 */
export function latchAbortMarkers(configured: unknown): boolean {
	if (latched === undefined) {
		latched = resolveAbortMarkersSetting(configured);
		if (isMainThread) setEnvironmentData(LATCH_KEY, latched);
	}
	return latched;
}

export function abortMarkersEnabled(): boolean {
	return latched === true;
}

/** Switches the process-global setting; only between tests, with no transaction open. Returns the prior value. */
export function setAbortMarkersForTests(enabled: boolean): boolean | undefined {
	const prior = latched;
	latched = enabled;
	RocksDatabase.config({ transactionLogAbortMarkers: enabled });
	return prior;
}
