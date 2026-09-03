'use strict';

import { readdir, lstat, realpath, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageChannel, Worker } from 'node:worker_threads';

import harperLogger from '../utility/logging/harper_logger.ts';
import { PACKAGE_ROOT } from '../utility/packageUtils.js';
import {
	buildWorkerExecArgv,
	buildWorkerResourceLimits,
	isProcessShuttingDown,
} from '../server/threads/manageThreads.js';

/**
 * How long a certification load may take before the candidate is rejected.
 *
 * Its OWN budget, measured from validator spawn — deliberately not the operations-API timeout. A component
 * may legally declare a longer load timeout than that, so borrowing it would reject a candidate the
 * serving workers would happily load; and a clock started at the request would already be overdue after a
 * long `npm install`. Callers with no request budget at all (boot, `addComponent`) get this default.
 */
const DEFAULT_CERTIFICATION_TIMEOUT_MS = 120_000;

/**
 * The maximum number of certification workers alive at once.
 *
 * Deploys are already serialized per component by the preparation lock, but not across components, and a
 * certification thread is a whole module graph. Bounded so a burst of deploys cannot spawn one thread per
 * component simultaneously.
 */
const MAX_CONCURRENT_CERTIFICATIONS = 2;

/**
 * Verdict slots in the shared buffer below. A message can be lost — the validator exits the instant it has
 * posted, and on Windows the parent observes that exit before the queued message — so the pass/fail bit
 * travels through shared memory, which needs no event-loop turn and cannot be outrun by the exit. The
 * message still carries the candidate's error text, which is detail rather than authority.
 *
 * `NO_ANSWER` is the initial value, so silence remains a failure rather than becoming a pass.
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

/** How long to wait for a validator to actually go away before giving up and saying so. */
const TERMINATION_GRACE_MS = 5000;

/**
 * How long a rejection waits for the validator's queued message after its exit.
 *
 * The shared flag says a candidate was rejected; only the MESSAGE carries the candidate's own error text,
 * and on Windows the exit consistently beats it. Settling on the flag alone reported every Windows rejection
 * as "exited before reporting why" and then closed the channel, discarding the syntax error the operator
 * needed. The flag is already the authority, so this waits only for the detail — and briefly.
 */
const REJECTION_DETAIL_GRACE_MS = 250;

/** The module links `symlinkHarperModule` maintains inside a component's `node_modules`. */
const HARPER_MODULE_LINKS = ['harper', 'harperdb'];

/**
 * What the candidate's `node_modules` held BEFORE certification loaded it.
 *
 * Taken so the cleanup below can put the tree back exactly as the deploy staged it, rather than removing a
 * link that was already there. That distinction is not academic: a `file:<directory>` deploy stages a
 * SYMLINK to the developer's own source directory, so certification reads and writes through it — and a
 * developer working on that component very likely already has `node_modules/harper` pointing at this
 * install. Deleting theirs would be certification reaching outside the candidate to modify a working tree.
 */
async function snapshotHarperModuleLinks(
	candidateDirPath: string,
	installRoot: string
): Promise<{ hadNodeModules: boolean; preexisting: Set<string> }> {
	const nodeModulesDir = join(candidateDirPath, 'node_modules');
	const preexisting = new Set<string>();
	let hadNodeModules = false;
	try {
		await lstat(nodeModulesDir);
		hadNodeModules = true;
	} catch {
		return { hadNodeModules, preexisting };
	}
	for (const name of HARPER_MODULE_LINKS) {
		try {
			if ((await realpath(join(nodeModulesDir, name))) === installRoot) preexisting.add(name);
		} catch {}
	}
	return { hadNodeModules, preexisting };
}

/**
 * Remove the `node_modules/harper` (and `harperdb`) link the certification load created.
 *
 * `symlinkHarperModule` links the running install into a component's `node_modules` on EVERY non-root load,
 * so certifying a candidate writes into the tree it is only supposed to read — and that tree is then renamed
 * into the live path. The link is not part of what the deploy staged, and a serving worker recreates it the
 * next time it loads the component, so removing it restores the staged bytes rather than taking anything
 * away. Left behind it turns every walk of the component into a walk of the whole Harper install: the packer
 * dereferences and recurses into symlinked directories, so `package_component` packaged the install.
 *
 * Only a link this certification created, and only one resolving to THIS install, is removed — a component
 * that ships or installs a `node_modules/harper` of its own keeps it.
 */
async function removeCertificationLinks(
	candidateDirPath: string,
	appName: string,
	installRoot: string,
	before: { hadNodeModules: boolean; preexisting: Set<string> }
): Promise<void> {
	const nodeModulesDir = join(candidateDirPath, 'node_modules');
	for (const name of HARPER_MODULE_LINKS) {
		if (before.preexisting.has(name)) continue;
		const linkPath = join(nodeModulesDir, name);
		try {
			if (!(await lstat(linkPath)).isSymbolicLink()) continue;
			if ((await realpath(linkPath)) !== installRoot) continue;
			await rm(linkPath, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			harperLogger.warn(
				`Could not remove the ${name} module link certification left in the ${appName} candidate; ` +
					`packaging or copying this component will follow it into the Harper install:`,
				error
			);
		}
	}
	// The load creates `node_modules` when the candidate has none, and an empty directory left behind is
	// still a difference from the staged tree.
	if (before.hadNodeModules) return;
	try {
		if ((await readdir(nodeModulesDir)).length === 0) await rmdir(nodeModulesDir);
	} catch {}
}

let active = 0;
/** Queued waiters. Each returns whether it accepted the slot being offered; a lapsed one declines. */
const waiting: (() => boolean)[] = [];

async function acquireSlot(timeoutMs: number): Promise<() => void> {
	// A released slot is HANDED to the next waiter without `active` ever dipping. Decrementing and then
	// waking a waiter that increments a microtask later leaves a window a fresh caller can claim through
	// synchronously, sending the woken waiter to the back of its own queue; and a release offered to a
	// waiter that has already timed out would be swallowed, leaving a free slot nobody is woken for.
	//
	// The wait is bounded because a validator that will not die keeps its slot deliberately (see the
	// termination path), and an unbounded queue behind it would hold every later deploy inside the
	// preparation lock with nothing to report.
	const deadline = Date.now() + timeoutMs;
	while (active >= MAX_CONCURRENT_CERTIFICATIONS) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			const error: any = new Error(
				`No certification slot became available within ${timeoutMs}ms; ${MAX_CONCURRENT_CERTIFICATIONS} ` +
					`validator(s) are still running`
			);
			error.statusCode = 503;
			throw error;
		}
		let settled = false;
		let resolveWait!: (inherited: boolean) => void;
		const waited = new Promise<boolean>((resolve) => (resolveWait = resolve));
		const waiter = () => {
			if (settled) return false;
			settled = true;
			resolveWait(true);
			return true;
		};
		waiting.push(waiter);
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			const index = waiting.indexOf(waiter);
			if (index !== -1) waiting.splice(index, 1);
			resolveWait(false);
		}, remaining);
		timer.unref?.();
		const inherited = await waited;
		// Cleared either way, so an admitted waiter does not keep its closure registered until a deadline
		// that no longer applies to it.
		clearTimeout(timer);
		// The slot came from the releaser with `active` already accounting for it, so this caller holds it
		// without incrementing — which is what makes the handoff a handoff.
		if (inherited) return makeRelease();
	}
	active++;
	return makeRelease();
}

function makeRelease(): () => void {
	let released = false;
	return () => {
		if (released) return;
		released = true;
		// Offer the slot along the queue until someone takes it. Only if nobody does does the count fall.
		while (waiting.length > 0) {
			if (waiting.shift()!()) return;
		}
		active--;
	};
}

export interface CertificationOutcome {
	certified: boolean;
	/** Why not, when `certified` is false. Always present in that case. */
	error?: Error;
}

/**
 * Load a candidate in an ephemeral worker and report whether it loaded.
 *
 * NOT `startWorker()`. That function constructs a `MessageChannel` for every connected port, announces the
 * new port to every peer, and registers the worker for monitoring and restart — so a certification worker
 * would join the ITC mesh, meaning a candidate's top-level `server.registerOperation()` could announce
 * itself to main and traffic could route at a thread that is about to exit. It would also cost
 * O(deploys × workers) channels on a large node. Only the *option construction* is worth sharing, and that
 * is deliberately kept small here rather than reaching into the serving-worker path.
 *
 * Every outcome other than an explicit passing verdict is a failure, because `.complete` — which this
 * gates — is what crash recovery treats as proof that a validation happened.
 */
export async function certifyCandidate(
	candidateDirPath: string,
	appName: string,
	{ timeoutMs = DEFAULT_CERTIFICATION_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<CertificationOutcome> {
	// The same guard `startWorker` applies. A deploy racing shutdown would otherwise spawn a thread the
	// shutdown path does not know about, and then wait out its deadline on a process that is leaving.
	if (isProcessShuttingDown()) {
		const error: any = new Error(`Cannot certify ${appName} while the Harper process is shutting down`);
		error.statusCode = 503;
		return { certified: false, error };
	}
	let releaseSlot: () => void;
	try {
		releaseSlot = await acquireSlot(timeoutMs);
	} catch (error) {
		return { certified: false, error: error as Error };
	}
	// The COMPILED sibling, referenced the way `jobRunner` references `jobProcess.js`: workers load from the
	// build output, and `__dirname` resolves there without assuming where the package root is.
	const entry = join(__dirname, './deployValidator.js');
	let worker: Worker | undefined;
	// Must be installed the moment the worker exists, never in the `finally`: the validator `realExit`s
	// immediately after posting, so a listener attached after the exit has already fired never runs, and
	// `certifyCandidate` then never returns while holding the preparation lock.
	let exited: Promise<void> | undefined;
	// Set when a validator outlives its termination grace, so its slot is deliberately not returned.
	let slotHeld = false;
	let settled = false;
	let timer: NodeJS.Timeout | undefined;
	// A channel of its own, never `parentPort`: that carries Harper's ITC traffic, so an unrelated message
	// arriving first reads as a malformed verdict. On a dedicated channel, anything non-conforming really is.
	const { port1: verdicts, port2: verdictPort } = new MessageChannel();
	const verdictFlag = new Int32Array(new SharedArrayBuffer(VERDICT_SLOTS * 4));
	// Before the load, so the cleanup in the `finally` can tell what it created from what was already there.
	const installRoot = await realpath(PACKAGE_ROOT).catch(() => undefined);
	const linksBefore = installRoot ? await snapshotHarperModuleLinks(candidateDirPath, installRoot) : undefined;

	try {
		return await new Promise<CertificationOutcome>((resolve) => {
			// Exactly one settlement, whichever of the outcomes below happens first. A candidate with a
			// syntax error emits `error` AND then `exit`; a candidate that posts a verdict and then throws
			// during teardown does the reverse. Either way the first answer stands.
			const settle = (outcome: CertificationOutcome) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				resolve(outcome);
			};
			const fail = (message: string) => settle({ certified: false, error: new Error(message) });

			try {
				const started = new Worker(entry, {
					workerData: {
						candidateDirPath,
						appName,
						verdictPort,
						verdictFlag,
						// `server/DESIGN.md`: "Workers receive `workerData.noServerStart = true` — never start the
						// server inside a worker." Without it `threadServer` boots at module scope and loads every
						// root component, so the validator would serve traffic and certify the wrong thing.
						noServerStart: true,
					},
					transferList: [verdictPort],
					// The same interpreter setup every Harper worker gets. Without it this thread cannot load
					// Harper's own module graph at all — a module that imports JSON fails outright — so this is
					// shared with `startWorker` rather than reconstructed.
					// Without the configured APM preloads: a validator is a throwaway thread, and resolving the
					// preload list from here would memoize it earlier than the first serving worker — see
					// `buildWorkerExecArgv`.
					execArgv: buildWorkerExecArgv({ preloads: false }),
					// Bounded like every other Harper worker. Without limits a candidate whose top-level load
					// builds a large in-memory index balloons a thread nothing constrains, and the OOM killer
					// takes the whole process down mid-deploy — while the previous release was healthy.
					resourceLimits: buildWorkerResourceLimits(),
					argv: process.argv.slice(2),
				});
				worker = started;
				exited = new Promise<void>((resolve) => started.once('exit', () => resolve()));
			} catch (error) {
				// A synchronous spawn throw is a deploy failure, not a candidate failure — and specifically
				// not a success. Under thread pressure a node will refuse deploys rather than publish
				// uncertified trees.
				const spawnError = error instanceof Error ? error : new Error(String(error));
				spawnError.message = `Could not start a validator to certify ${appName}: ${spawnError.message}`;
				(spawnError as any).statusCode = 503;
				settle({ certified: false, error: spawnError });
				return;
			}

			timer = setTimeout(() => {
				fail(`Certification of ${appName} did not finish within ${timeoutMs}ms; the candidate was not ` + `published`);
			}, timeoutMs);
			// A hung candidate must not keep the process alive once the parent has stopped caring.
			timer.unref?.();

			verdicts.on('message', (message: unknown) => {
				if (!message || typeof message !== 'object' || typeof (message as any).ok !== 'boolean') {
					fail(`Certification of ${appName} returned a malformed verdict`);
					return;
				}
				if ((message as any).ok) {
					settle({ certified: true });
					return;
				}
				const error = new Error((message as any).message || `${appName} failed to load`);
				if (typeof (message as any).stack === 'string') error.stack = (message as any).stack;
				settle({ certified: false, error });
			});
			worker.on('error', (error) => {
				const failure = error instanceof Error ? error : new Error(String(error));
				settle({ certified: false, error: failure });
			});
			worker.on('exit', (code) => {
				// Only reached when no verdict MESSAGE arrived first. The shared flag is written before the
				// validator exits, so it is still authoritative here — this is the ordinary path on Windows,
				// where the exit consistently beats the queued message.
				const flag = Atomics.load(verdictFlag, SLOT_VERDICT);
				if (flag === VERDICT_NO_ANSWER) {
					fail(
						`Certification of ${appName} exited with code ${code} without reporting a verdict: ` +
							describeProgress(Atomics.load(verdictFlag, SLOT_PROGRESS))
					);
					return;
				}
				if (flag === VERDICT_CERTIFIED) {
					settle({ certified: true });
					return;
				}
				// Rejected for certain; what is still in flight is WHY. The message handler settles with the
				// candidate's own error if it lands first, and `settle` takes the first answer either way, so
				// this is the fallback rather than a race the detail can lose outright.
				setTimeout(() => {
					fail(`${appName} failed to load during certification (its validator exited before reporting why)`);
				}, REJECTION_DETAIL_GRACE_MS).unref?.();
			});
		});
	} finally {
		// Terminated and AWAITED before the caller may delete the candidate tree, so a still-running
		// candidate cannot race the sweep.
		//
		// `terminate()` triggers a NAPI segfault under Bun — `manageThreads` avoids it the same way — so
		// there the worker is asked to exit itself and its exit awaited. A termination that FAILS is
		// reported rather than treated as cleanup done: the caller is about to remove a tree this thread
		// may still be reading.
		if (worker) {
			// Every wait here is bounded: this `finally` blocks the caller's deploy, so a termination that never
			// settles would hold the preparation lock indefinitely.
			const grace = () => new Promise<void>((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS).unref?.());
			try {
				// Asking is what can fail; waiting for the exit must happen either way. A synchronous throw from
				// the ask must not skip the wait, or the caller sweeps a tree whose thread is still terminating.
				let asked: Promise<unknown> = Promise.resolve();
				try {
					asked =
						typeof (globalThis as any).Bun !== 'undefined'
							? // `terminate()` triggers a NAPI segfault under Bun; `manageThreads` asks the worker to
								// exit itself for the same reason.
								(worker.postMessage({ type: 'force-exit' }), Promise.resolve())
							: worker.terminate().then(
									() => {},
									() => {}
								);
				} catch (error) {
					harperLogger.warn(`Could not ask the validator for ${appName} to exit; waiting for it anyway:`, error);
				}
				// ONE grace for the whole thing: racing terminate and then the exit separately could wait twice
				// over before calling a hung validator hung, inside a deploy holding the preparation lock.
				const outcome = await Promise.race([
					Promise.all([asked, exited ?? Promise.resolve()]).then(() => 'exited' as const),
					grace().then(() => 'still-running' as const),
				]);
				// A validator that would not die keeps its slot: releasing it would admit another thread while a
				// runaway one still holds the candidate tree open, and the caller is about to sweep that tree.
				if (outcome === 'still-running') {
					// Held until it actually goes away, not forever: permanently held slots would shrink the cap
					// for the life of the process, trading a bounded overcommit for an unbounded outage.
					slotHeld = true;
					harperLogger.error(
						`The validator certifying ${appName} did not exit within ${TERMINATION_GRACE_MS}ms; holding its ` +
							`slot until it does, and its candidate tree may still be open`
					);
					void (exited ?? Promise.resolve()).then(() => {
						harperLogger.warn(`The validator certifying ${appName} exited late; returning its slot`);
						releaseSlot();
					});
				}
			} catch (error) {
				harperLogger.warn(
					`Could not terminate the validator for ${appName}; its candidate tree may still be open:`,
					error
				);
			}
		}
		if (timer) clearTimeout(timer);
		// After the termination above, so this is not racing a thread that could relink. Runs for every
		// outcome: a rejected candidate is swept and a certified one is renamed live, and neither should
		// carry the link.
		if (installRoot && linksBefore) await removeCertificationLinks(candidateDirPath, appName, installRoot, linksBefore);
		// Both ends, or the channel keeps this thread's event loop referenced.
		verdicts.close();
		if (!slotHeld) releaseSlot();
	}
}
