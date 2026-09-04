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
// The prune is O(map) and the monitor calls reportLongLivedHolder once per over-threshold transaction
// per tick, so pruning per call is O(N^2) in exactly the leak this reporting exists to describe.
const ATTRIBUTION_PRUNE_INTERVAL_MS = 60000;

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
let lastAttributionPruneAt = 0;
// No threshold observed yet; every real one is 0 or positive.
let thresholdInEffectMs = -1;

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
 * Drop the accrued backoff when the configured threshold changes, so a handle already under
 * observation is re-measured against the new one. Without this, `nextReportAgeMs` keeps whatever it
 * was given at first observation: lowering the threshold during an incident would not bring a
 * silent handle's first report forward, and raising it would not quiet one. Reporting each live
 * holder once more at the new threshold is what an operator who just changed it is asking for.
 */
function rebaseIfThresholdChanged(thresholdMs: number): void {
	if (thresholdMs === thresholdInEffectMs) return;
	thresholdInEffectMs = thresholdMs;
	sweepReports.clear();
	attributionReports.clear();
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
	try {
		const thresholdMs = getReportThresholdMs();
		rebaseIfThresholdChanged(thresholdMs);
		if (thresholdMs === 0 || !registryStatusFn) return;
		const status = registryStatusFn();
		const seen = new Set<string>();
		const due: { path: string | undefined; id: number; ageMs: number; state: ReportState }[] = [];
		let missingDetails = false;
		for (const database of status) {
			const details = database.transactionDetails;
			if (!details) {
				missingDetails = true;
				continue;
			}
			for (const handle of details) {
				// `nextReportAgeMs` is seeded at the threshold and only grows, so a handle below it can never
				// be due and the state kept for it can never change an outcome. Skipping it keeps a healthy
				// node's pass allocation-free instead of paying a key, a state and two container entries per
				// live handle per minute.
				if (handle.ageMs < thresholdMs) continue;
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
				`Long-lived RocksDB transaction handle: id ${handle.id} has been open for ${prettyDuration(handle.ageMs)} on database ${handle.path ?? '?'}. ` +
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
		rebaseIfThresholdChanged(thresholdMs);
		if (thresholdMs === 0) return;
		const now = Date.now();
		if (now - lastAttributionPruneAt >= ATTRIBUTION_PRUNE_INTERVAL_MS) {
			lastAttributionPruneAt = now;
			const expiredBefore = now - ATTRIBUTION_STATE_TTL_MS;
			for (const [key, state] of attributionReports)
				if (state.touchedAt < expiredBefore) attributionReports.delete(key);
		}
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
 * The live handles that could be holding the write intent a stuck commit is parked on, as a sentence
 * to append to that commit's log. A handle on another database is offered too, labelled with its path:
 * the verification table is one process-global slot array whose hash mixes in the database id, so a
 * holder in `system` or `oauth` collides with — and parks — a `data` commit at the same rate two `data`
 * keys do. Rank puts the stuck commit's own database first, then age. Age only ranks: a coordinated
 * retry parks on whichever transaction holds the slot when the commit reaches it, which can be younger
 * than the commit itself, so filtering by age could drop the real holder.
 * Returns '' rather than throwing — the caller's own 503 must survive a failure here.
 */
export function describeHolderCandidates(
	databasePath: string | undefined,
	excludeNativeId: number | undefined
): string {
	// Honors the disable value for the same reason the other two surfaces do: an operator who set the
	// threshold to 0 asked for no reporting, and this surface is reached from the write path.
	if (!databasePath || !registryStatusFn) return '';
	try {
		if (getReportThresholdMs() === 0) return '';
		const target = resolve(databasePath);
		const candidates: { id: number; ageMs: number; sameDatabase: boolean; path: string | undefined }[] = [];
		let targetSeen = false;
		let targetHasDetails = false;
		for (const database of registryStatusFn()) {
			// An entry with no path can never be the target, and resolve() would throw on it — which,
			// inside this loop, would drop the candidate list for every database rather than just this one.
			const sameDatabase = database.path != null && resolve(database.path) === target;
			const details = database.transactionDetails;
			if (sameDatabase) {
				targetSeen = true;
				if (details) targetHasDetails = true;
			}
			if (!details) continue;
			for (const handle of details)
				if (!sameDatabase || handle.id !== excludeNativeId)
					candidates.push({ id: handle.id, ageMs: handle.ageMs, sameDatabase, path: database.path });
		}
		if (!targetHasDetails) {
			// A database with no other handles is normal; no entry at all means the join between a store's
			// path and the registry's path has drifted, which is the one worth telling an operator apart.
			logger.debug?.(
				targetSeen
					? `Registry entry for ${target} exposes no transactionDetails; only other databases' handles can be offered as holder candidates for its stuck commit`
					: `No registry entry for ${target}; only other databases' handles can be offered as holder candidates for its stuck commit`
			);
		}
		if (candidates.length === 0) return '';
		candidates.sort((a, b) => Number(b.sameDatabase) - Number(a.sameDatabase) || b.ageMs - a.ageMs);
		const shortlist = candidates.slice(0, MAX_HOLDER_CANDIDATES);
		// Ranking this database first and then capping can bury the one candidate the cross-database
		// search exists to surface: a busy database routinely has MAX_HOLDER_CANDIDATES handles of its
		// own, so a foreign holder would only ever appear inside the "and N more" count. Give the oldest
		// one the last slot instead.
		if (shortlist.length === MAX_HOLDER_CANDIDATES && shortlist.every((candidate) => candidate.sameDatabase)) {
			const foreign = candidates.find((candidate) => !candidate.sameDatabase);
			if (foreign) shortlist[MAX_HOLDER_CANDIDATES - 1] = foreign;
		}
		const named = shortlist
			.map(
				(candidate) =>
					`${candidate.id} (open ${prettyDuration(candidate.ageMs)}${candidate.sameDatabase ? '' : ` on ${candidate.path ?? '?'}`})`
			)
			.join(', ');
		return (
			` Live transaction handles, any of which could hold the write intent this commit is parked on ` +
			`(the verification table is one process-global slot array, so a handle on another database can hold it), ` +
			`this database first, oldest first: ${named}` +
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
	lastAttributionPruneAt = 0;
	thresholdInEffectMs = -1;
	if (sweepTimer) {
		clearInterval(sweepTimer);
		sweepTimer = undefined;
	}
}
