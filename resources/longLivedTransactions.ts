import { isMainThread, threadId } from 'node:worker_threads';
import { resolve } from 'node:path';
import { registryStatus } from '@harperfast/rocksdb-js';
import { logger } from '../utility/logging/logger.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';
import * as envMngr from '../utility/environment/environmentManager.ts';
import { convertToMS, prettyDuration } from '../utility/common_utils.ts';

const DEFAULT_REPORT_THRESHOLD_MS = 300000;
const SWEEP_INTERVAL_MS = 60000;
// One line per over-age handle would, against a large leak, block the main thread's socket routing
// for as long as it took to format them. The per-handle backoff below rotates the cap over the whole
// set across passes, so every holder is still named eventually.
const MAX_REPORTED_PER_SWEEP = 10;
const MAX_HOLDER_CANDIDATES = 3;
// The sweep prunes against the handles it just enumerated; the attribution map has no such
// enumeration, so its entries expire instead. Far longer than a sweep interval, so a still-live
// holder keeps its backoff.
const ATTRIBUTION_STATE_TTL_MS = 3600000;

type RegistryStatusFn = typeof registryStatus;
let registryStatusFn: RegistryStatusFn | undefined = typeof registryStatus === 'function' ? registryStatus : undefined;

// Report state is keyed by database path AND native id: rocksdb-js allocates transaction ids per
// database descriptor, so two databases routinely both have id 2, and a reopen restarts the counter.
type ReportState = { nextReportAgeMs: number; lastAgeMs: number; touchedAt: number };
const sweepReports = new Map<string, ReportState>();
const attributionReports = new Map<string, ReportState>();
let sweepTimer: NodeJS.Timeout | undefined;
let invalidThresholdWarned = false;
let missingDetailsWarned = false;

function reportKey(databasePath: string | undefined, nativeId: number): string {
	return `${databasePath ?? '?'} ${nativeId}`;
}

/**
 * Record this observation of a handle and return its report state. A shrinking age means the id was
 * reused by a reopened descriptor, so the previous holder's backoff must not suppress the new one.
 */
function observeHandle(
	reports: Map<string, ReportState>,
	key: string,
	ageMs: number,
	thresholdMs: number
): ReportState {
	let state = reports.get(key);
	if (state && ageMs < state.lastAgeMs) state = undefined;
	if (!state) {
		state = { nextReportAgeMs: thresholdMs, lastAgeMs: ageMs, touchedAt: 0 };
		reports.set(key, state);
	}
	state.lastAgeMs = ageMs;
	state.touchedAt = Date.now();
	return state;
}

/**
 * Push this handle's next report out to twice its current age, so one held for hours produces a
 * handful of lines rather than one per pass. Called only where a line was actually emitted: advancing
 * it for a handle the per-pass cap skipped would silence that handle without ever naming it.
 */
function markReported(state: ReportState, ageMs: number): void {
	state.nextReportAgeMs = ageMs * 2;
}

/**
 * How old a native transaction handle must be before it is reported, in ms; 0 disables every surface
 * here. Read per pass rather than cached so a live config reload takes effect. A value that cannot
 * be a duration falls back to the default instead of silently disabling reporting.
 */
export function getReportThresholdMs(): number {
	const configured = envMngr.get(CONFIG_PARAMS.STORAGE_LONGTRANSACTIONREPORTTHRESHOLD);
	if (configured == null) return DEFAULT_REPORT_THRESHOLD_MS;
	// convertToMS returns 0 for anything that is neither string nor number, which YAML hands us for
	// `yes`/`no` (booleans) and for an object left by a config merge — indistinguishable from the
	// documented 0 that disables reporting, so it would silently switch off what the operator configured.
	const ms = typeof configured === 'string' || typeof configured === 'number' ? convertToMS(configured) : NaN;
	if (ms === 0) return 0;
	if (!Number.isFinite(ms) || ms < 0) {
		if (!invalidThresholdWarned) {
			invalidThresholdWarned = true;
			logger.warn?.(
				`Invalid storage.longTransactionReportThreshold "${configured}"; using default ${DEFAULT_REPORT_THRESHOLD_MS}ms`
			);
		}
		return DEFAULT_REPORT_THRESHOLD_MS;
	}
	return ms;
}

/**
 * Report every native transaction handle in the process-global rocksdb-js registry that has been open
 * past the threshold — including handles no `DatabaseTransaction` owns, which is the one class of
 * holder no other surface can see (harper#2471). The registry spans worker threads, so this runs on
 * the main thread only; a per-thread sweep would report each handle once per worker.
 */
export function runLongLivedTransactionSweep(): void {
	const thresholdMs = getReportThresholdMs();
	if (thresholdMs === 0 || !registryStatusFn) {
		// Disabling and re-enabling must not leave a still-live handle sitting behind a backoff ceiling
		// it accrued before the pause, which would delay its first report after the operator asked for one.
		if (thresholdMs === 0 && sweepReports.size > 0) sweepReports.clear();
		return;
	}
	try {
		const status = registryStatusFn();
		const seen = new Set<string>();
		const due: { path: string; id: number; ageMs: number; state: ReportState }[] = [];
		let missingDetails = false;
		for (const database of status) {
			const details = database.transactionDetails;
			if (!details) {
				missingDetails = true;
				continue;
			}
			for (const handle of details) {
				const key = reportKey(database.path, handle.id);
				seen.add(key);
				const state = observeHandle(sweepReports, key, handle.ageMs, thresholdMs);
				if (handle.ageMs >= state.nextReportAgeMs)
					due.push({ path: database.path, id: handle.id, ageMs: handle.ageMs, state });
			}
		}
		for (const key of sweepReports.keys()) if (!seen.has(key)) sweepReports.delete(key);
		if (missingDetails && !missingDetailsWarned) {
			missingDetailsWarned = true;
			logger.warn?.(
				'Long-lived transaction reporting is degraded: the installed @harperfast/rocksdb-js does not expose registryStatus().transactionDetails (requires 2.8.0)'
			);
		}
		if (due.length === 0) return;
		due.sort((a, b) => b.ageMs - a.ageMs);
		for (const handle of due.slice(0, MAX_REPORTED_PER_SWEEP)) {
			markReported(handle.state, handle.ageMs);
			logger.warn?.(
				`Long-lived RocksDB transaction handle: id ${handle.id} has been open for ${prettyDuration(handle.ageMs)} on database ${handle.path}. ` +
					`A handle this old can hold write intents that park other writers' commits, and pins a read snapshot that blocks version reclamation.`
			);
		}
		if (due.length > MAX_REPORTED_PER_SWEEP) {
			logger.warn?.(
				`${due.length - MAX_REPORTED_PER_SWEEP} further RocksDB transaction handle(s) are open past the ${prettyDuration(thresholdMs)} reporting threshold and were not listed individually.`
			);
		}
	} catch (error) {
		logger.error?.('Error sweeping for long-lived transaction handles', error);
	}
}

/**
 * Start the periodic sweep. Armed unconditionally on the main thread — the pass itself honors a live
 * threshold change, including one that disables it — and idempotent because the thread startup path
 * that calls it can run more than once.
 */
export function startLongLivedTransactionReporting(): void {
	if (!isMainThread || sweepTimer) return;
	if (!registryStatusFn) {
		logger.debug?.('Long-lived transaction reporting unavailable; @harperfast/rocksdb-js exposes no registryStatus()');
		return;
	}
	sweepTimer = setInterval(runLongLivedTransactionSweep, SWEEP_INTERVAL_MS).unref();
}

export type LongLivedHolder = {
	databasePath: string | undefined;
	nativeId: number;
	ageMs: number;
	databaseName?: string;
	tableName?: string;
	// A thunk, not a number: the caller's count walks the whole staged write set, and the backoff below
	// suppresses most ticks — the #2471 shape is a transaction holding a large write set for hours, so
	// paying for that walk on every suppressed tick is the one cost this reporting must not add.
	countPendingWrites: () => number;
	states: string[];
	timeoutBudget?: number;
	startedFrom?: { resourceName: string; method: string };
};

/**
 * Report a handle this thread owns, with the attribution the registry sweep cannot supply. The native
 * id is the join key between the two: the sweep names an id, this names who holds it and which state
 * kept the open-transaction monitor from reaping it (harper#2471). Never throws — the monitor
 * interval that calls it has no handler.
 */
export function reportLongLivedHolder(holder: LongLivedHolder): void {
	try {
		const thresholdMs = getReportThresholdMs();
		if (thresholdMs === 0) {
			if (attributionReports.size > 0) attributionReports.clear();
			return;
		}
		const expiredBefore = Date.now() - ATTRIBUTION_STATE_TTL_MS;
		for (const [key, state] of attributionReports) if (state.touchedAt < expiredBefore) attributionReports.delete(key);
		const state = observeHandle(
			attributionReports,
			reportKey(holder.databasePath, holder.nativeId),
			holder.ageMs,
			thresholdMs
		);
		if (holder.ageMs < state.nextReportAgeMs) return;
		markReported(state, holder.ageMs);
		const table = holder.tableName ? `.${holder.tableName}` : '';
		logger.warn?.(
			`Harper transaction has held RocksDB transaction ${holder.nativeId} for ${prettyDuration(holder.ageMs)} ` +
				`on thread ${threadId}, database ${holder.databaseName ?? '?'}${table} (${holder.databasePath ?? '?'}), ` +
				`holding ${holder.countPendingWrites()} staged write(s), state: ${holder.states.join('+')}` +
				(holder.timeoutBudget ? `, open-transaction budget ${holder.timeoutBudget}ms` : '') +
				(holder.startedFrom?.resourceName
					? `, started from ${holder.startedFrom.resourceName}${holder.startedFrom.method ? '.' + holder.startedFrom.method : ''}`
					: '') +
				'. It is not being reaped by the open-transaction monitor; the state tells you why.'
		);
	} catch (error) {
		logger.debug?.('Failed to report a long-lived transaction holder', error);
	}
}

/**
 * The live handles on `databasePath` that could be holding the write intent a stuck commit is parked
 * on, oldest first, as a sentence to append to that commit's log. Age only ranks them: a coordinated
 * retry parks on whichever transaction holds the verification-table slot when the commit reaches it,
 * which can be younger than the commit itself, so filtering by age could drop the real holder.
 * Returns '' rather than throwing — the caller's own 503 must survive a failure here.
 */
export function describeHolderCandidates(
	databasePath: string | undefined,
	excludeNativeId: number | undefined
): string {
	if (!databasePath || !registryStatusFn) return '';
	try {
		const target = resolve(databasePath);
		const entry = registryStatusFn().find((database) => resolve(database.path) === target);
		const details = entry?.transactionDetails;
		if (!details) {
			// A database with no other handles is normal; no entry at all means the join between a store's
			// path and the registry's path has drifted, which is the one worth telling an operator apart.
			logger.debug?.(
				entry
					? `Registry entry for ${target} exposes no transactionDetails; cannot offer holder candidates for its stuck commit`
					: `No registry entry for ${target}; cannot offer holder candidates for its stuck commit`
			);
			return '';
		}
		const candidates = details.filter((handle) => handle.id !== excludeNativeId).sort((a, b) => b.ageMs - a.ageMs);
		if (candidates.length === 0) return '';
		const named = candidates
			.slice(0, MAX_HOLDER_CANDIDATES)
			.map((handle) => `${handle.id} (open ${prettyDuration(handle.ageMs)})`)
			.join(', ');
		return (
			` Live transaction handles on this database, any of which could hold the write intent this commit is parked on, oldest first: ${named}` +
			(candidates.length > MAX_HOLDER_CANDIDATES ? `, and ${candidates.length - MAX_HOLDER_CANDIDATES} more.` : '.')
		);
	} catch {
		return '';
	}
}

/** Test seam; undefined simulates a binding with no registryStatus(). */
export function setRegistryStatusForTests(fn?: RegistryStatusFn): void {
	registryStatusFn = fn;
}

/** Test seam: the backoff state, once-per-process warnings and armed sweep that outlive a single test. */
export function resetLongLivedTransactionReportsForTests(): void {
	sweepReports.clear();
	attributionReports.clear();
	invalidThresholdWarned = false;
	missingDetailsWarned = false;
	if (sweepTimer) {
		clearInterval(sweepTimer);
		sweepTimer = undefined;
	}
}
