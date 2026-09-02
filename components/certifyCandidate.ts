'use strict';

import { join } from 'node:path';
import { MessageChannel, Worker } from 'node:worker_threads';

import harperLogger from '../utility/logging/harper_logger.ts';
import { buildWorkerExecArgv } from '../server/threads/manageThreads.js';

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

let active = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<() => void> {
	if (active >= MAX_CONCURRENT_CERTIFICATIONS) await new Promise<void>((resolve) => waiting.push(resolve));
	active++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		active--;
		waiting.shift()?.();
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
	const releaseSlot = await acquireSlot();
	// The COMPILED sibling, referenced the way `jobRunner` references `jobProcess.js`: workers load from the
	// build output, and `__dirname` resolves there without assuming where the package root is.
	const entry = join(__dirname, './deployValidator.js');
	let worker: Worker | undefined;
	let settled = false;
	let timer: NodeJS.Timeout | undefined;
	// A channel of its own, NOT `parentPort`: Harper's worker machinery uses that for its own ITC traffic,
	// so a verdict read from it would compete with unrelated messages — the first one to arrive was being
	// rejected as a malformed verdict. On a dedicated channel, anything that does not conform really is one.
	const { port1: verdicts, port2: verdictPort } = new MessageChannel();

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
				worker = new Worker(entry, {
					workerData: {
						candidateDirPath,
						appName,
						verdictPort,
						// `server/DESIGN.md`: "Workers receive `workerData.noServerStart = true` — never start the
						// server inside a worker." Without it `threadServer` boots at module scope and loads every
						// root component, so the validator would serve traffic and certify the wrong thing.
						noServerStart: true,
					},
					transferList: [verdictPort],
					// The same interpreter setup every Harper worker gets. Without it this thread cannot load
					// Harper's own module graph at all — a module that imports JSON fails outright — so this is
					// shared with `startWorker` rather than reconstructed.
					execArgv: buildWorkerExecArgv(),
					argv: process.argv.slice(2),
				});
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
				// Only reached when no verdict arrived first; a verdict already settled it.
				fail(`Certification of ${appName} exited with code ${code} without reporting a verdict`);
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
			const exited = new Promise<void>((resolve) => worker!.once('exit', () => resolve()));
			try {
				if (typeof (globalThis as any).Bun !== 'undefined') {
					worker.postMessage({ type: 'force-exit' });
					const grace = new Promise<void>((resolve) => setTimeout(resolve, 5000).unref?.());
					await Promise.race([exited, grace]);
				} else {
					await worker.terminate();
					await exited;
				}
			} catch (error) {
				harperLogger.warn(
					`Could not terminate the validator for ${appName}; its candidate tree may still be open:`,
					error
				);
			}
		}
		if (timer) clearTimeout(timer);
		// Both ends, or the channel keeps this thread's event loop referenced.
		verdicts.close();
		releaseSlot();
	}
}
