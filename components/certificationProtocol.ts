/**
 * The wire between a deploy validator and whatever supervises it.
 *
 * Its own module, with NO Harper imports, because both ends need it and one of them is a process that must
 * be able to read a verdict without having loaded (or survived loading) the module graph it is testing.
 * Importing `certifyCandidate` for these would pull `manageThreads` into the validator.
 */

export const VERDICT_NO_ANSWER = 0;
export const VERDICT_CERTIFIED = 1;
export const VERDICT_REJECTED = 2;

/**
 * Slots in the shared buffer. Slot 0 carries the verdict; slot 1 carries how far the validator got.
 *
 * Progress travels through shared memory because that is the only channel that survives this thread's exit:
 * a worker's `console.error` is piped to the parent asynchronously, so output written on the way out loses
 * the same race the verdict message loses. An exit code alone cannot say which phase the thread was in, nor
 * whether it ended itself.
 */
export const SLOT_VERDICT = 0;
export const SLOT_PROGRESS = 1;
export const VERDICT_SLOTS = 2;

/** Phases the validator records in `SLOT_PROGRESS`, each strictly later than the last. */
export const PROGRESS_NOTHING = 0;
export const PROGRESS_MODULE_SCOPE = 1;
export const PROGRESS_CERTIFY_ENTERED = 2;
export const PROGRESS_ROOT_PLUGINS_LOADED = 3;
export const PROGRESS_CANDIDATE_LOADED = 4;
export const PROGRESS_TEARDOWN_DONE = 5;
/** Added to the phase when the validator's own `exit` handler runs, distinguishing a self-exit from a teardown. */
export const PROGRESS_EXIT_OBSERVED = 100;

const PROGRESS_NAMES: Record<number, string> = {
	[PROGRESS_NOTHING]: 'never ran its module body',
	[PROGRESS_MODULE_SCOPE]: 'reached module scope but not the certification body',
	[PROGRESS_CERTIFY_ENTERED]: 'entered certification but did not finish loading root plugins',
	[PROGRESS_ROOT_PLUGINS_LOADED]: 'loaded root plugins but did not finish loading the candidate',
	[PROGRESS_CANDIDATE_LOADED]: 'loaded the candidate but did not finish tearing it down',
	[PROGRESS_TEARDOWN_DONE]: 'finished teardown but reported no verdict',
};

/** Render `SLOT_PROGRESS` for an operator: which phase, and whether the thread ended itself. */
export function describeProgress(progress: number): string {
	const selfExited = progress >= PROGRESS_EXIT_OBSERVED;
	const phase = selfExited ? progress - PROGRESS_EXIT_OBSERVED : progress;
	const described = PROGRESS_NAMES[phase] ?? `reached an unknown phase (${phase})`;
	// A thread torn down from outside — `terminate()`, a native abort, the process going away — never runs
	// its own exit handler, so the absence of that mark is the interesting half.
	return selfExited ? `it ${described} and then exited itself` : `it ${described} and was ended from outside`;
}

/**
 * Process exit codes for the certification helper, which are the SUPERVISOR's authority.
 *
 * A `SharedArrayBuffer` cannot cross a process boundary, so the flag the candidate's thread writes is
 * readable only inside the helper. The helper reads it and encodes the answer here: an exit code survives a
 * lost IPC message the way the flag survives a lost worker message, and a candidate cannot set it — worker
 * threads have no `process.send`, and nothing in the candidate's thread chooses the helper's exit.
 *
 * Any other code — a signal, a crash, a bootstrap failure — is a rejection, because silence must never be a
 * pass.
 */
export const HOST_EXIT_CERTIFIED = 0;
export const HOST_EXIT_REJECTED = 20;
export const HOST_EXIT_NO_VERDICT = 21;
