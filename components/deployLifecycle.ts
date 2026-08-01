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
// fires locally so Scopes (and any plugin subscribers) can react: Scopes pause
// their EntryHandlers on start and resume them on end. The result is that
// during a deploy, no watcher fires events for the deployed component, and
// after the deploy the watcher compares the new tree with its retained snapshot
// and emits the same logical add/change/unlink events consumers saw before #1806.
//
// State sharing across threads is intentionally narrow: local deployment-owner
// records are rebuilt from the broadcast stream and reclaimed when their owner
// thread exits. Plugins that need to gate their own work on deploy progress
// import `deployLifecycle` and listen to the events directly.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isMainThread, threadId } from 'node:worker_threads';
import {
	broadcast,
	broadcastWithAcknowledgement,
	isThreadRunning,
	onMessageByType,
	onThreadExit,
} from '../server/threads/manageThreads.js';
import harperLogger from '../utility/logging/harper_logger.ts';

const DEPLOY_LIFECYCLE_MSG = 'harper:deploy:lifecycle';

export type DeployPhase = 'start' | 'end';
export type DeployLifecycleEvent = {
	name: string;
	phase: DeployPhase;
	deploymentId?: string;
	ownerThreadId?: number;
};

type DeployLifecycleEventsMap = {
	'deploy:start': [componentName: string];
	'deploy:end': [componentName: string];
};

class DeployLifecycle extends EventEmitter<DeployLifecycleEventsMap> {
	#deployments = new Map<string, { name: string; ownerThreadId: number }>();
	#byComponent = new Map<string, Set<string>>();
	#deadOwners = new Set<number>();
	#legacyDeployments = new Map<string, string[]>();
	#legacySequence = 0;

	isDeployInFlight(componentName: string): boolean {
		return (this.#byComponent.get(componentName)?.size ?? 0) > 0;
	}

	// Process a deploy lifecycle event in-process. Called both from the
	// broadcast receiver (for events originating on another thread) and from
	// the broadcaster (so the originating thread also reacts locally).
	_handle(event: DeployLifecycleEvent): void {
		const ownerThreadId = event.ownerThreadId ?? threadId;
		let deploymentId = event.deploymentId;
		if (event.phase === 'start') {
			if (this.#deadOwners.has(ownerThreadId)) return;
			if (!deploymentId) {
				deploymentId = `legacy:${threadId}:${++this.#legacySequence}`;
				const legacy = this.#legacyDeployments.get(event.name) ?? [];
				legacy.push(deploymentId);
				this.#legacyDeployments.set(event.name, legacy);
			}
			if (this.#deployments.has(deploymentId)) return;
			const active = this.#byComponent.get(event.name) ?? new Set<string>();
			this.#deployments.set(deploymentId, { name: event.name, ownerThreadId });
			this.#byComponent.set(event.name, active);
			active.add(deploymentId);
			if (active.size === 1) this.#emitSafely('deploy:start', event.name);
			return;
		}
		if (!deploymentId) deploymentId = this.#legacyDeployments.get(event.name)?.pop();
		if (deploymentId) this.#removeDeployment(deploymentId);
	}

	_reclaimOwner(ownerThreadId: number): void {
		this.#deadOwners.add(ownerThreadId);
		for (const [deploymentId, deployment] of this.#deployments) {
			if (deployment.ownerThreadId === ownerThreadId) this.#removeDeployment(deploymentId);
		}
	}

	async _reclaimOwnerAfterTermination(
		ownerThreadId: number,
		waitForTermination: (ownerThreadId: number) => Promise<void> = waitForOwnerTermination
	): Promise<void> {
		this.#deadOwners.add(ownerThreadId);
		await waitForTermination(ownerThreadId);
		this._reclaimOwner(ownerThreadId);
	}

	#removeDeployment(deploymentId: string): void {
		const deployment = this.#deployments.get(deploymentId);
		if (!deployment) return;
		this.#deployments.delete(deploymentId);
		const active = this.#byComponent.get(deployment.name);
		if (!active) return;
		active.delete(deploymentId);
		if (active.size === 0) {
			this.#byComponent.delete(deployment.name);
			this.#emitSafely('deploy:end', deployment.name);
		}
	}

	#emitSafely(event: 'deploy:start' | 'deploy:end', componentName: string): void {
		for (const listener of this.rawListeners(event)) {
			try {
				listener.call(this, componentName);
			} catch (error) {
				harperLogger.error(`Listener for ${event} threw for ${componentName}:`, error);
			}
		}
	}

	// Test-only: clear in-flight state without firing events.
	_clearForTests(): void {
		this.#deployments.clear();
		this.#byComponent.clear();
		this.#deadOwners.clear();
		this.#legacyDeployments.clear();
		this.#legacySequence = 0;
	}
}

export const deployLifecycle = new DeployLifecycle();

async function waitForOwnerTermination(ownerThreadId: number): Promise<void> {
	while (await isThreadRunning(ownerThreadId)) await delay(25);
}

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
onThreadExit((deadThreadId: number) => {
	void deployLifecycle
		._reclaimOwnerAfterTermination(deadThreadId)
		.catch((error) => harperLogger.error(`Could not reclaim deployments from thread ${deadThreadId}:`, error));
});

/**
 * Announce the start of a deploy for `componentName`. Awaits acknowledgement
 * from every worker so the caller can rely on all watchers being suppressed
 * before writing into the component directory.
 *
 * Ref-counted via DeployLifecycle so overlapping deploys of the same
 * component compose correctly (each call must be paired with exactly one
 * broadcastDeployEnd).
 */
export async function broadcastDeployStart(componentName: string): Promise<string> {
	ensureReceiver();
	const deploymentId = randomUUID();
	const event: DeployLifecycleEvent = { name: componentName, phase: 'start', deploymentId, ownerThreadId: threadId };
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
	return deploymentId;
}

/**
 * Announce the end of a deploy for `componentName`. Fire-and-forget — the
 * caller (the deploy operation) is done by this point and doesn't need to
 * wait for every worker to reopen its watcher.
 *
 * Must be called exactly once per matching broadcastDeployStart, even if the
 * deploy errored — typically from a `finally` block.
 */
export function broadcastDeployEnd(componentName: string, deploymentId: string): void {
	ensureReceiver();
	const event: DeployLifecycleEvent = { name: componentName, phase: 'end', deploymentId, ownerThreadId: threadId };
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
