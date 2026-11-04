/**
 * Waiting for a worker restart on behalf of an operation that reports whether it finished.
 *
 * No single clock bounds a restart: each replacement has its own startup backstop, a worker draining
 * in-flight work may hold its exit for as long as the drain ceiling allows, and a wide pool rolls a
 * few workers at a time. So the wait follows the restart's own progress and gives up only when
 * nothing has moved for `idleTimeoutMs`, or at the absolute `ceilingMs` — a caller holding an API
 * response open cannot wait forever.
 */

/** How long the restart may go without reporting progress before the wait gives up. */
export const RESTART_IDLE_TIMEOUT_MS = 60_000;
/** Absolute cap on the wait, matching the default shutdown-drain ceiling. */
export const RESTART_WAIT_CEILING_MS = 600_000;

export interface RestartOutcome {
	completed: boolean;
	/** Workers left running the previous code because their replacement never came up. */
	workersKeptOnOldCode?: number;
	/** Replacements that never reported starting after their predecessor was already gone. */
	replacementsNotStarted?: number;
	/** The wait ended because the restart stopped reporting progress. */
	stalled?: boolean;
	/** The restart was handed to another thread, which reports its own completion. */
	handedOff?: boolean;
	/** No restart was performed: the process is already shutting down. */
	declined?: boolean;
	error?: any;
}

/** Reports progress; a deadline says the reporter is busy until then (e.g. a drain it asked for). */
export type RestartProgress = (untilMs?: number) => void;

export function awaitRestart(
	startRestart: (onProgress: RestartProgress) => any,
	{ idleTimeoutMs = RESTART_IDLE_TIMEOUT_MS, ceilingMs = RESTART_WAIT_CEILING_MS } = {}
): Promise<RestartOutcome> {
	let idleTimer: any, ceilingTimer: any;
	let settled = false;
	let reportStalled: (outcome: RestartOutcome) => void;
	const done = (outcome: RestartOutcome) => {
		settled = true;
		clearTimeout(idleTimer);
		clearTimeout(ceilingTimer);
		return outcome;
	};
	const onProgress: RestartProgress = (untilMs) => {
		// The restart keeps reporting past the point where the wait gave up; re-arming a timer then
		// would leave a live handle behind for as long as the last reported deadline.
		if (settled) return;
		clearTimeout(idleTimer);
		// A reported deadline is what the reporter says it needs, so honor it over the idle window; the
		// absolute ceiling is what keeps that bounded.
		const wait = Math.max(idleTimeoutMs, untilMs === undefined ? 0 : untilMs - Date.now());
		idleTimer = setTimeout(() => reportStalled(done({ completed: false, stalled: true })), wait);
	};
	const stalled = new Promise<RestartOutcome>((resolve) => {
		reportStalled = resolve;
	});
	const ceiling = new Promise<RestartOutcome>((resolve) => {
		ceilingTimer = setTimeout(() => resolve(done({ completed: false })), ceilingMs);
	});
	onProgress();
	const restarted = Promise.resolve()
		.then(() => startRestart(onProgress))
		.then(
			(result) =>
				done(
					result && typeof result === 'object'
						? result.declined
							? { completed: false, declined: true }
							: {
									completed: true,
									workersKeptOnOldCode: result.workersKeptOnOldCode ?? 0,
									replacementsNotStarted: result.replacementsNotStarted ?? 0,
								}
						: // Only the thread performing the restart can report on it; from a worker
							// restartWorkers() hands it off and resolves with nothing.
							{ completed: false, handedOff: true }
				),
			(error) => done({ completed: false, error })
		);
	return Promise.race([restarted, stalled, ceiling]);
}
