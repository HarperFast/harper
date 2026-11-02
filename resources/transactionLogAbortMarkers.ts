import { RocksDatabase } from '@harperfast/rocksdb-js';

let latched: boolean | undefined;

/** `storage.rocks.transactionLogAbortMarkers`: on unless configured false. */
export function resolveAbortMarkersSetting(configured: unknown): boolean {
	if (configured === false || configured === 0) return false;
	if (typeof configured === 'string') return !['false', '0', 'no', 'off'].includes(configured.trim().toLowerCase());
	return true;
}

/**
 * The value every RocksDB `config()` call passes. Latched at the first call: the native setting is
 * process-global, so every worker resolves the same startup config, and a later change needs a restart.
 */
export function latchAbortMarkers(configured: unknown): boolean {
	return (latched ??= resolveAbortMarkersSetting(configured));
}

/** Whether rocksdb-js marks an aborted transaction's log batch, so committed readers skip it. */
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
