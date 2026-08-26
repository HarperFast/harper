/**
 * Waiting for a worker restart on behalf of an operation that reports whether it finished.
 *
 * A restart is not bounded by any one clock: each replacement carries its own startup backstop, a
 * worker draining in-flight work can hold its own exit for as long as the drain ceiling allows, and
 * a wide thread pool rolls a few workers at a time. So the wait follows the restart's own progress
 * — `restartWorkers()` reports each replaced worker, and a draining worker reports the deadline it
 * asked for — and gives up only when nothing has moved for `idleTimeoutMs`, or when the absolute
 * `ceilingMs` is reached (a caller holding an API response open cannot wait forever).
 */

/** How long the restart may go without reporting progress before the wait gives up. */
export const RESTART_IDLE_TIMEOUT_MS = 60_000;
/**
 * Absolute cap on the wait, matching the default shutdown-drain ceiling: past this point the
 * restart is still running, but nothing useful is gained by holding the caller's response.
 */
export const RESTART_WAIT_CEILING_MS = 600_000;

export interface RestartOutcome {
	/** Whether the restart itself finished (as opposed to the wait giving up on it). */
	completed: boolean;
	/** Workers left running the previous code because their replacement never came up. */
	workersKeptOnOldCode?: number;
	/** Replacements that never reported starting after their predecessor was already gone. */
	replacementsNotStarted?: number;
	/** The wait ended because the restart stopped reporting progress. */
	stalled?: boolean;
	/** The restart was handed to another thread and could not be awaited here. */
	handedOff?: boolean;
	/** The restart rejected. */
	error?: any;
}

/** Reports progress; a deadline says the reporter is busy until then (e.g. a drain it asked for). */
export type RestartProgress = (untilMs?: number) => void;

export function awaitRestart(
	startRestart: (onProgress: RestartProgress) => any,
	{ idleTimeoutMs = RESTART_IDLE_TIMEOUT_MS, ceilingMs = RESTART_WAIT_CEILING_MS } = {}
): Promise<RestartOutcome> {
	let idleTimer: any, ceilingTimer: any;
	let reportStalled: (outcome: RestartOutcome) => void;
	const onProgress: RestartProgress = (untilMs) => {
		clearTimeout(idleTimer);
		// A reported deadline is what the reporter says it needs, so honor it over the idle window —
		// the absolute ceiling below is what keeps that bounded.
		const wait = Math.max(idleTimeoutMs, untilMs === undefined ? 0 : untilMs - Date.now());
		idleTimer = setTimeout(() => reportStalled({ completed: false, stalled: true }), wait);
	};
	const stalled = new Promise<RestartOutcome>((resolve) => {
		reportStalled = resolve;
		onProgress();
	});
	const restarted = Promise.resolve(startRestart(onProgress)).then(
		(result) =>
			result && typeof result === 'object'
				? {
						completed: true,
						workersKeptOnOldCode: result.workersKeptOnOldCode ?? 0,
						replacementsNotStarted: result.replacementsNotStarted ?? 0,
					}
				: // Only the main thread performs a restart; from a worker restartWorkers() hands it off and
					// resolves with nothing, which is not a completed restart.
					{ completed: false, handedOff: true },
		(error) => ({ completed: false, error })
	);
	const ceiling = new Promise<RestartOutcome>((resolve) => {
		ceilingTimer = setTimeout(() => resolve({ completed: false }), ceilingMs);
	});
	return Promise.race([restarted, stalled, ceiling]).finally(() => {
		clearTimeout(idleTimer);
		clearTimeout(ceilingTimer);
	});
}
