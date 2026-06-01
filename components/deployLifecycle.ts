// Cross-thread deploy lifecycle events.
//
// Component deploys (extract + npm install) write into the component directory,
// which is exactly what every Scope's EntryHandler is watching. Without
// coordination this drives a restart-request storm — each file change fires
// scope.requestRestart(), which closes and recreates every component watcher
// through componentLoader, briefly doubling inotify-handle occupancy and
// occasionally exhausting the OS limit (harper#488).
//
// This module solves that by broadcasting a structured "deploy:start" /
// "deploy:end" signal to every Harper thread. Each thread's deploy emitter
// fires locally so Scopes (and any plugin subscribers) can react: Scopes close
// their EntryHandlers on start, recreate them on end. The result is that
// during a deploy, no watcher fires events for the deployed component, and
// after the deploy the recreated watcher emits one fresh add per current file
// — collapsed by the existing restart debounce into a single restart.
//
// State sharing across threads is intentionally narrow: the local Set of
// in-flight component names is rebuilt from the broadcast stream. Plugins that
// need to gate their own work on deploy progress import `deployLifecycle` and
// listen to the events directly.

import { EventEmitter } from 'node:events';
import { isMainThread } from 'node:worker_threads';
import { broadcast, broadcastWithAcknowledgement, onMessageByType } from '../server/threads/manageThreads.js';

const DEPLOY_LIFECYCLE_MSG = 'harper:deploy:lifecycle';

export type DeployPhase = 'start' | 'end';
export type DeployLifecycleEvent = { name: string; phase: DeployPhase };

type DeployLifecycleEventsMap = {
	'deploy:start': [componentName: string];
	'deploy:end': [componentName: string];
};

class DeployLifecycle extends EventEmitter<DeployLifecycleEventsMap> {
	// Ref-counts in-flight deploys per component. Concurrent deploys of the
	// same name (rare, but possible if an operator queues two before the first
	// resolves) overlap: 0→1 fires deploy:start, 1→0 fires deploy:end. Any
	// intermediate increment/decrement is silent so watchers aren't toggled
	// out from under an active deploy by a peer ending early.
	#inFlight = new Map<string, number>();

	isDeployInFlight(componentName: string): boolean {
		return (this.#inFlight.get(componentName) ?? 0) > 0;
	}

	// Process a deploy lifecycle event in-process. Called both from the
	// broadcast receiver (for events originating on another thread) and from
	// the broadcaster (so the originating thread also reacts locally).
	_handle(event: DeployLifecycleEvent): void {
		const current = this.#inFlight.get(event.name) ?? 0;
		if (event.phase === 'start') {
			this.#inFlight.set(event.name, current + 1);
			if (current === 0) this.emit('deploy:start', event.name);
		} else {
			const next = Math.max(0, current - 1);
			if (next === 0) {
				this.#inFlight.delete(event.name);
				if (current > 0) this.emit('deploy:end', event.name);
			} else {
				this.#inFlight.set(event.name, next);
			}
		}
	}

	// Test-only: clear in-flight state without firing events.
	_clearForTests(): void {
		this.#inFlight.clear();
	}
}

export const deployLifecycle = new DeployLifecycle();

let receiverInstalled = false;
function ensureReceiver() {
	if (receiverInstalled) return;
	receiverInstalled = true;
	onMessageByType(DEPLOY_LIFECYCLE_MSG, (msg: { type: string; event: DeployLifecycleEvent }) => {
		deployLifecycle._handle(msg.event);
	});
}

// Install the cross-thread receiver at module load. Receiving threads (workers)
// don't call the broadcast helpers themselves but must still react to deploy
// events originating on the main thread — without this, a deploy on main would
// suppress only the main thread's watchers and the worker watchers would keep
// firing restart storms (harper#488).
ensureReceiver();

/**
 * Announce the start of a deploy for `componentName`. Awaits acknowledgement
 * from every worker so the caller can rely on all watchers being suppressed
 * before writing into the component directory.
 *
 * Ref-counted via DeployLifecycle so overlapping deploys of the same
 * component compose correctly (each call must be paired with exactly one
 * broadcastDeployEnd).
 */
export async function broadcastDeployStart(componentName: string): Promise<void> {
	ensureReceiver();
	const event: DeployLifecycleEvent = { name: componentName, phase: 'start' };
	deployLifecycle._handle(event); // local thread first
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// broadcastWithAcknowledgement only resolves once every peer has processed
		// the message, which is what we want before we start touching files. From
		// a worker, this still reaches main + sibling workers; from main it reaches
		// all workers.
		//
		// Race against a 5s timeout so an unresponsive worker can't hang the
		// deploy indefinitely — the deploy is meant to be best-effort coordinated,
		// not gated on every worker acknowledging.
		const timeout = new Promise<void>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('Broadcast acknowledgement timed out')), 5000);
			timer.unref?.();
		});
		await Promise.race([broadcastWithAcknowledgement({ type: DEPLOY_LIFECYCLE_MSG, event }), timeout]);
	} catch (error) {
		// A broadcast failure here is non-fatal: the deploy can still proceed,
		// the worst case is a transient restart storm. Don't block the deploy.
		// (Errors are already surfaced through the existing logger by manageThreads.)
		void error;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Announce the end of a deploy for `componentName`. Fire-and-forget — the
 * caller (the deploy operation) is done by this point and doesn't need to
 * wait for every worker to reopen its watcher.
 *
 * Must be called exactly once per matching broadcastDeployStart, even if the
 * deploy errored — typically from a `finally` block.
 */
export function broadcastDeployEnd(componentName: string): void {
	ensureReceiver();
	const event: DeployLifecycleEvent = { name: componentName, phase: 'end' };
	deployLifecycle._handle(event);
	try {
		void broadcast({ type: DEPLOY_LIFECYCLE_MSG, event }, false);
	} catch (error) {
		void error;
	}
}

// Tests need to reset module state between cases. We deliberately do NOT reset
// `receiverInstalled`: manageThreads.onMessageByType has no deregistration API,
// so flipping the flag would let a subsequent ensureReceiver() pile a second
// listener and double-increment the refcount on every broadcast.
export function _resetForTests(): void {
	deployLifecycle.removeAllListeners();
	deployLifecycle._clearForTests();
}

// Marker so callers (e.g. Application.ts) can tell whether they're running in
// a context where broadcasting will reach peers — during startup before
// threads are wired up, broadcasts are no-ops but still safe to call.
export const supportsCrossThreadBroadcast = isMainThread;
