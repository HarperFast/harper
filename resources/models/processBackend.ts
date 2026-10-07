/**
 * Process-wide model backends (`models.registerProcessBackend`): one backend instance per Harper
 * process, owned by one thread and served to every thread that registered it.
 *
 * The registry in `backendRegistry.ts` is per thread, so a component that registers an in-process
 * backend builds one per worker: one model, one GPU context and one warmup each. Here every
 * registering thread installs a proxy in its own registry and claims the key from the main thread.
 * Main elects one claimant as owner, only the owner runs the factory, and the proxies forward calls
 * to it over the thread port mesh. See resources/models/DESIGN.md.
 *
 *  - Control plane, worker ⇄ main: CLAIM, RELEASE, STARTED and START_FAILED in; STATE out to every
 *    claimant. Main holds the only copy of the state, so every thread reports the same readiness.
 *  - Data plane, caller ⇄ owner, sibling to sibling and never through main: REQUEST and CANCEL in,
 *    RESPONSE out.
 *
 * Main coordinates because it is never restarted and sees every worker exit; a worker owns because
 * application code (the factory) runs only on workers. With no worker threads, main is the worker
 * and owns itself.
 */
import { isMainThread, threadId, workerData } from 'node:worker_threads';
import * as manageThreads from '../../server/threads/manageThreads.js';
import { getWorkerIndex, hasThreadExited, onMessageByType, onThreadExit } from '../../server/threads/manageThreads.js';
import { ITC_EVENT_TYPES } from '../../utility/hdbTerms.ts';
import harperLogger from '../../utility/logging/harper_logger.ts';
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import {
	assertBackendForKind,
	assertKindAndId,
	constructBackend,
	getBackend,
	ModelBackendRegistrationError,
	registerBackend,
} from './backendRegistry.ts';
import type {
	BackendOpts,
	BackendStatus,
	ModelBackend,
	ModelBackendUnavailableReason,
	ModelCallResult,
	ModelCapabilities,
	ModelKind,
	ProcessBackendFactory,
	ProcessBackendOptions,
	TokenUsage,
} from './types.ts';

// The connected-ports array with `sendToThread`, assigned to the `threads` global by manageThreads
// (the same access pattern as registeredOperations.ts).
declare const threads: { sendToThread(threadId: number, message: unknown): boolean };

const log = harperLogger.loggerWithTag('models');

const CLAIM = 'models-process-backend-claim';
const RELEASE = 'models-process-backend-release';
const STARTED = 'models-process-backend-started';
const START_FAILED = 'models-process-backend-start-failed';
const STATE = 'models-process-backend-state';
const REQUEST = 'models-process-backend-request';
const RESPONSE = 'models-process-backend-response';
const CANCEL = 'models-process-backend-cancel';
const MAIN_THREAD_ID = 0;

const DEFAULTS = { concurrency: 1, maxPending: 256, maxBatchInputs: 1, maxRestarts: 1 };

type Method = 'embed' | 'generate' | 'decide' | 'scoreChoices';
type State = 'starting' | 'ready' | 'failed';
type ResolvedOptions = Required<Omit<ProcessBackendOptions, 'timeoutMs'>> & { timeoutMs?: number };
type WireError = {
	name: string;
	message: string;
	statusCode?: number;
	code?: string | number;
	reason?: ModelBackendUnavailableReason;
	usage?: TokenUsage;
};

interface StateMessage {
	type: typeof STATE;
	key: string;
	version: number;
	epoch: number;
	state: State;
	owner?: number;
	restarts: number;
	maxRestarts: number;
	generation: number;
	name?: string;
	capabilities?: ModelCapabilities;
	reason?: ModelBackendUnavailableReason;
	error?: { name: string; message: string };
}

interface RequestMessage {
	type: typeof REQUEST;
	key: string;
	kind: ModelKind;
	logicalName: string;
	request: number;
	origin: number;
	epoch: number;
	method: Method;
	args: unknown[];
	opts: Record<string, unknown>;
	accounting: unknown;
}

/**
 * A call to a process-wide backend found no owner to serve it: the owner exited, its factory failed,
 * the restart budget is spent, or the call timed out. The message names the backend and the reason
 * only; a failed start's error stays on `cause` and in `models.backendStatus`.
 */
export class ModelBackendUnavailableError extends ServerError {
	reason: ModelBackendUnavailableReason;
	constructor(kind: ModelKind, logicalName: string, reason: ModelBackendUnavailableReason, cause?: unknown) {
		super(`Process-wide backend '${kind}.${logicalName}' is unavailable (${reason})`, 503);
		this.name = 'ModelBackendUnavailableError';
		this.reason = reason;
		if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
	}
}

/** The owner of a process-wide backend has `maxPending` requests queued already; retry later. */
export class ModelBackendBusyError extends ServerError {
	constructor(kind: ModelKind, logicalName: string) {
		super(`Process-wide backend '${kind}.${logicalName}' is busy`, 503);
		this.name = 'ModelBackendBusyError';
	}
}

// ---------------------------------------------------------------------------------------------
// Messaging. A thread can be its own owner or coordinator (main with no workers, or a worker that
// owns the backend it calls), so a send to this thread is delivered to the local handler, on a
// later turn as a port would deliver it.

const localHandlers = new Map<string, (message: any) => void>();

function listen(type: string, handler: (message: any) => void): void {
	localHandlers.set(type, handler);
	onMessageByType(type, (message: any) => handler(message));
}

function send(target: number, message: { type: string }): boolean {
	if (target === threadId) {
		const handler = localHandlers.get(message.type);
		setImmediate(() => {
			try {
				handler?.(message);
			} catch (error) {
				// The same containment notifyMessageListeners gives a handler a port delivers to.
				log.error?.(`models: handling '${message.type}' failed`, error);
			}
		});
		return true;
	}
	return threads.sendToThread(target, message);
}

function keyFor(kind: ModelKind, logicalName: string): string {
	// An isolated application's dedicated worker has a registry of its own today; keying by it keeps
	// its process-wide backends out of every other application's threads.
	return JSON.stringify([
		(workerData as { isolatedApplication?: string } | null)?.isolatedApplication ?? '',
		kind,
		logicalName,
	]);
}

/** The worker generation this thread was started in; `restartWorkers` bumps it, a crash restart does not. */
function currentGeneration(): number {
	return (workerData as { restartNumber?: number } | null)?.restartNumber ?? manageThreads.restartNumber ?? 1;
}

// ---------------------------------------------------------------------------------------------
// Coordinator (main thread).

interface Claimant {
	generation: number;
	seq: number;
	eligible: boolean;
}

interface Entry {
	key: string;
	claimants: Map<number, Claimant>;
	owner?: number;
	epoch: number;
	version: number;
	state: State;
	restarts: number;
	maxRestarts: number;
	generation: number;
	name?: string;
	capabilities?: ModelCapabilities;
	reason?: ModelBackendUnavailableReason;
	error?: { name: string; message: string };
}

const entries = new Map<string, Entry>();
let claimSequence = 0;

function onClaim(message: {
	key: string;
	origin: number;
	generation: number;
	maxRestarts: number;
	eligible: boolean;
}): void {
	const { key, origin } = message;
	// A claim can lose the race with its thread's exit, which is reported once; ignoring it here keeps
	// a dead thread from ever being elected.
	if (origin !== threadId && hasThreadExited(origin)) return;
	let entry = entries.get(key);
	let changed = false;
	if (!entry) {
		entry = {
			key,
			claimants: new Map(),
			epoch: 0,
			version: 0,
			state: 'starting',
			restarts: 0,
			maxRestarts: message.maxRestarts,
			generation: message.generation,
		};
		entries.set(key, entry);
	} else if (message.generation > entry.generation) {
		// An operator restart or a deploy starts a new generation, with a fresh budget, and clears a
		// failure, so a fixed release can serve again. The current owner keeps serving until it leaves.
		entry.generation = message.generation;
		entry.restarts = 0;
		entry.maxRestarts = message.maxRestarts;
		if (entry.state === 'failed') {
			entry.state = 'starting';
			entry.reason = undefined;
			entry.error = undefined;
			changed = true;
		}
	}
	entry.claimants.set(origin, {
		generation: message.generation,
		seq: entry.claimants.get(origin)?.seq ?? claimSequence++,
		eligible: message.eligible === true,
	});
	if (entry.owner === undefined && entry.state !== 'failed' && elect(entry)) changed = true;
	publish(entry, changed ? undefined : origin);
}

function onRelease(message: { key: string; origin: number }): void {
	const entry = entries.get(message.key);
	if (!entry?.claimants.delete(message.origin)) return;
	if (entry.owner === message.origin) {
		// A planned exit (the thread is shutting down): hand over without charging the restart budget.
		entry.owner = undefined;
		if (entry.state !== 'failed') {
			entry.state = 'starting';
			elect(entry);
		}
	}
	publish(entry);
}

function onStarted(message: {
	key: string;
	origin: number;
	epoch: number;
	name: string;
	capabilities: ModelCapabilities;
}): void {
	const entry = entries.get(message.key);
	if (!entry || entry.owner !== message.origin || entry.epoch !== message.epoch || entry.state !== 'starting') return;
	entry.state = 'ready';
	entry.name = message.name;
	entry.capabilities = message.capabilities;
	entry.reason = undefined;
	entry.error = undefined;
	publish(entry);
}

function onStartFailed(message: {
	key: string;
	origin: number;
	epoch: number;
	error: { name: string; message: string };
}): void {
	const entry = entries.get(message.key);
	if (!entry || entry.owner !== message.origin || entry.epoch !== message.epoch) return;
	loseOwner(entry, 'start-failed', message.error, message.origin);
}

function onCoordinatedThreadExit(deadThreadId: number): void {
	for (const entry of entries.values()) {
		if (!entry.claimants.delete(deadThreadId)) continue;
		if (entry.owner === deadThreadId)
			loseOwner(
				entry,
				'owner-exited',
				{ name: 'ModelBackendUnavailableError', message: `owner thread ${deadThreadId} exited` },
				deadThreadId
			);
	}
}

/**
 * An unplanned loss: restart on another claimant (this one, if it is the only one left) while the
 * generation's budget lasts, else fail until the next generation. Never a per-thread fallback.
 */
function loseOwner(
	entry: Entry,
	reason: ModelBackendUnavailableReason,
	error: { name: string; message: string },
	lost: number
): void {
	entry.owner = undefined;
	entry.name = undefined;
	entry.capabilities = undefined;
	entry.reason = reason;
	entry.error = error;
	if (entry.restarts < entry.maxRestarts) {
		entry.restarts++;
		entry.state = 'starting';
		elect(entry, lost);
		log.warn?.(
			`models: process-wide backend ${entry.key} lost its owner (${reason}); restart ${entry.restarts} of ${entry.maxRestarts}`
		);
	} else {
		entry.state = 'failed';
		log.error?.(
			`models: process-wide backend ${entry.key} lost its owner (${reason}) with no restarts left; its calls fail until the workers restart`
		);
	}
	publish(entry);
}

/**
 * Elect an eligible claimant, newest generation first so a rolling deploy lands on new code, then
 * the earliest claim; `avoid` (the owner just lost) only if nobody else is left.
 */
function elect(entry: Entry, avoid?: number): boolean {
	const preferred = ([a, claimA]: [number, Claimant], [b, claimB]: [number, Claimant]) => {
		if ((a === avoid) !== (b === avoid)) return b === avoid;
		if (claimA.generation !== claimB.generation) return claimA.generation > claimB.generation;
		return claimA.seq < claimB.seq;
	};
	let best: [number, Claimant] | undefined;
	for (const candidate of entry.claimants) {
		if (candidate[1].eligible && (best === undefined || preferred(candidate, best))) best = candidate;
	}
	entry.owner = best?.[0];
	if (best === undefined) return false;
	entry.epoch++;
	entry.state = 'starting';
	entry.name = undefined;
	entry.capabilities = undefined;
	return true;
}

function publish(entry: Entry, only?: number): void {
	entry.version++;
	const message: StateMessage = {
		type: STATE,
		key: entry.key,
		version: entry.version,
		epoch: entry.epoch,
		state: entry.state,
		owner: entry.owner,
		restarts: entry.restarts,
		maxRestarts: entry.maxRestarts,
		generation: entry.generation,
		name: entry.name,
		capabilities: entry.capabilities,
		reason: entry.reason,
		error: entry.error,
	};
	for (const target of only === undefined ? [...entry.claimants.keys()] : [only]) {
		try {
			send(target, message);
		} catch (error) {
			log.error?.(`models: could not send the state of process-wide backend ${entry.key} to thread ${target}`, error);
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Registering threads: the proxy (caller side) and, on the elected thread, the owner.

interface Slot {
	key: string;
	kind: ModelKind;
	logicalName: string;
	factory: ProcessBackendFactory;
	options: ResolvedOptions;
	proxy: ModelBackend;
	view?: StateMessage;
	/** The owner backend's name, from the latest ready push or answered call. */
	servedName?: string;
	capabilities: ModelCapabilities;
	waiters: Set<() => void>;
	run?: OwnerRun;
	released: boolean;
}

interface OwnerRun {
	epoch: number;
	phase: State;
	backend?: ModelBackend;
	error?: unknown;
	queue: Queued[];
	active: number;
	running: Map<string, Running>;
}

interface Queued {
	origin: number;
	request: number;
	method: Method;
	args: unknown[];
	opts: Record<string, unknown>;
	accounting: unknown;
	inputs: number;
	batchKey?: string;
}

interface Running {
	controller: AbortController;
	members: number;
	cancelled: Set<string>;
}

interface PendingCall {
	key: string;
	owner: number;
	kind: ModelKind;
	logicalName: string;
	finish(error: unknown, result?: ModelCallResult<unknown>): void;
}

const slots = new Map<string, Slot>();
const pendingCalls = new Map<number, PendingCall>();
let nextRequest = 1;

const base = (capabilities: Partial<ModelCapabilities>): ModelCapabilities =>
	Object.freeze({ embed: false, generate: false, stream: false, tools: false, adapters: false, ...capabilities });
/** What a proxy advertises before its owner reports: the one method its kind requires. */
const BASE_CAPABILITIES: Record<ModelKind, ModelCapabilities> = {
	embedding: base({ embed: true }),
	generative: base({ generate: true }),
	decision: base({ decide: true }),
};

/**
 * The owner's capabilities, less what the proxy does not forward: streaming, and methods the kind is
 * never resolved for.
 */
function proxyCapabilities(kind: ModelKind, reported: ModelCapabilities): ModelCapabilities {
	const capabilities: ModelCapabilities = { ...reported, stream: false };
	if (kind !== 'embedding') capabilities.embed = false;
	if (kind !== 'generative') {
		capabilities.generate = false;
		capabilities.scoreChoices = false;
	}
	if (kind !== 'decision') capabilities.decide = false;
	return Object.freeze(capabilities);
}

function makeProxy(slot: Slot): ModelBackend {
	const proxy: ModelBackend = {
		// The facade reads the name for a call's analytics row as the call resolves, so the name the
		// owner answered with wins; main's ready push can trail the first answered call.
		get name() {
			return slot.servedName ?? `process:${slot.logicalName}`;
		},
		capabilities: () => slot.capabilities,
	};
	if (slot.kind === 'embedding') proxy.embed = (input, opts) => invoke(slot, 'embed', [input], opts);
	else if (slot.kind === 'decision')
		proxy.decide = (state, schema, opts) => invoke(slot, 'decide', [state, schema], opts);
	else {
		proxy.generate = (input, opts) => invoke(slot, 'generate', [input], opts);
		proxy.scoreChoices = (input, choices, opts) => invoke(slot, 'scoreChoices', [input, choices], opts);
	}
	return proxy;
}

function positiveInteger(options: ProcessBackendOptions, field: keyof ProcessBackendOptions, minimum: number) {
	const value = options[field];
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < minimum)
		throw new ModelBackendRegistrationError(
			`${field} must be an integer of at least ${minimum}, got '${String(value)}'`
		);
	return value as number;
}

function resolveOptions(kind: ModelKind, options: ProcessBackendOptions | undefined): ResolvedOptions {
	if (options !== undefined && (typeof options !== 'object' || options === null))
		throw new ModelBackendRegistrationError('process backend options must be an object');
	const given = options ?? {};
	const resolved: ResolvedOptions = {
		concurrency: positiveInteger(given, 'concurrency', 1) ?? DEFAULTS.concurrency,
		maxPending: positiveInteger(given, 'maxPending', 0) ?? DEFAULTS.maxPending,
		maxBatchInputs: positiveInteger(given, 'maxBatchInputs', 1) ?? DEFAULTS.maxBatchInputs,
		maxRestarts: positiveInteger(given, 'maxRestarts', 0) ?? DEFAULTS.maxRestarts,
	};
	const timeoutMs = positiveInteger(given, 'timeoutMs', 1);
	if (timeoutMs !== undefined) resolved.timeoutMs = timeoutMs;
	if (resolved.maxBatchInputs > 1 && kind !== 'embedding')
		throw new ModelBackendRegistrationError('maxBatchInputs applies to embedding backends only');
	return resolved;
}

/**
 * Register `kind`/`id` once per process. Every thread that loads the component calls this where it
 * would call `registerBackend`; `factory` runs on the elected owner only, and each thread's registry
 * gets a proxy that forwards `embed`, `generate`, `decide` and `scoreChoices` to the owner. Calling
 * it again on a thread updates the factory and options a later start uses; a started owner keeps
 * the backend it built.
 */
export function registerProcessBackend(
	kind: ModelKind,
	id: string,
	factory: ProcessBackendFactory,
	options?: ProcessBackendOptions
): void {
	assertKindAndId(kind, id);
	if (typeof factory !== 'function')
		throw new ModelBackendRegistrationError(`process backend '${id}' needs a factory function`);
	const resolved = resolveOptions(kind, options);
	const key = keyFor(kind, id);
	let slot = slots.get(key);
	if (slot) {
		slot.factory = factory;
		slot.options = resolved;
	} else {
		slot = {
			key,
			kind,
			logicalName: id,
			factory,
			options: resolved,
			capabilities: BASE_CAPABILITIES[kind],
			waiters: new Set(),
			released: false,
		} as Slot;
		slot.proxy = makeProxy(slot);
		slots.set(key, slot);
	}
	registerBackend(kind, id, slot.proxy);
	// A thread that is shutting down has handed its claims back and must not be elected again.
	if (slot.released) return;
	const sent = send(MAIN_THREAD_ID, {
		type: CLAIM,
		key,
		origin: threadId,
		generation: currentGeneration(),
		maxRestarts: resolved.maxRestarts,
		// Main runs no application code while it has workers; it is eligible only as the lone worker.
		eligible: !isMainThread || getWorkerIndex() === 0,
	} as { type: string });
	if (!sent) log.warn?.(`models: could not reach the main thread to register process-wide backend '${kind}.${id}'`);
}

/** The status of the backend this thread resolves for `kind`/`id`. */
export function backendStatus(kind: ModelKind, id: string): BackendStatus | undefined {
	const registered = getBackend(kind, id);
	if (registered === undefined) return undefined;
	const slot = slots.get(keyFor(kind, id));
	if (!slot || slot.proxy !== registered) return { scope: 'thread', state: 'ready' };
	const view = slot.view;
	const status: BackendStatus = {
		scope: 'process',
		state: view?.state ?? 'starting',
		restarts: view?.restarts ?? 0,
		maxRestarts: view?.maxRestarts ?? slot.options.maxRestarts,
	};
	if (view?.owner !== undefined) status.owner = view.owner;
	if (view?.generation !== undefined) status.generation = view.generation;
	if (view?.reason !== undefined) status.reason = view.reason;
	if (view?.error !== undefined) status.error = { ...view.error };
	return status;
}

/** Diagnostic: the work an owner holds for `kind`/`id` on this thread, or undefined if it owns none. */
export function ownerLoad(kind: ModelKind, id: string): { queued: number; active: number; phase: State } | undefined {
	const run = slots.get(keyFor(kind, id))?.run;
	return run && { queued: run.queue.length, active: run.active, phase: run.phase };
}

function onState(message: StateMessage): void {
	const slot = slots.get(message.key);
	if (!slot || (slot.view && message.version <= slot.view.version)) return;
	slot.view = message;
	if (message.name !== undefined) slot.servedName = message.name;
	slot.capabilities =
		message.state === 'ready' && message.capabilities
			? proxyCapabilities(slot.kind, message.capabilities)
			: BASE_CAPABILITIES[slot.kind];
	if (message.owner === threadId && !slot.released) startOwner(slot, message.epoch);
	wake(slot);
}

function wake(slot: Slot): void {
	const waiters = [...slot.waiters];
	slot.waiters.clear();
	for (const waiter of waiters) waiter();
}

// Caller side ---------------------------------------------------------------------------------

/** Loop-level options: the `toolMode: 'auto'` loop runs on the caller and never hands these to a backend. */
const CALLER_ONLY_OPTIONS = new Set(['signal', 'accounting', 'toolHandlers', 'conversation']);

function sendableOptions(opts: Record<string, unknown>): Record<string, unknown> {
	const sendable: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(opts)) {
		if (CALLER_ONLY_OPTIONS.has(field) || typeof value === 'function') continue;
		sendable[field] = value;
	}
	return sendable;
}

/** The owner to send to, waiting for main to name one; rejects once the backend has failed. */
async function routeTo(slot: Slot, signal: AbortSignal | undefined, deadline: number | undefined) {
	// Each pass waits for a state change, the caller's abort or the deadline.
	for (;;) {
		const view = slot.view;
		if (view?.state === 'failed')
			throw new ModelBackendUnavailableError(
				slot.kind,
				slot.logicalName,
				'failed',
				view.error && Object.assign(new Error(view.error.message), { name: view.error.name })
			);
		if (view?.owner !== undefined) return { owner: view.owner, epoch: view.epoch };
		await new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				slot.waiters.delete(waiter);
				signal?.removeEventListener('abort', onAbort);
				if (timer) clearTimeout(timer);
			};
			const waiter = () => {
				cleanup();
				resolve();
			};
			const onAbort = () => {
				cleanup();
				reject(signal!.reason);
			};
			slot.waiters.add(waiter);
			signal?.addEventListener('abort', onAbort, { once: true });
			if (deadline !== undefined) {
				timer = setTimeout(
					() => {
						cleanup();
						reject(new ModelBackendUnavailableError(slot.kind, slot.logicalName, 'timeout'));
					},
					Math.max(0, deadline - Date.now())
				);
				timer.unref?.();
			}
		});
	}
}

async function invoke<T>(
	slot: Slot,
	method: Method,
	args: unknown[],
	opts: BackendOpts<Record<string, unknown>>
): Promise<ModelCallResult<T>> {
	const signal = opts?.signal as AbortSignal | undefined;
	signal?.throwIfAborted();
	const deadline = slot.options.timeoutMs === undefined ? undefined : Date.now() + slot.options.timeoutMs;
	const { owner, epoch } = await routeTo(slot, signal, deadline);
	signal?.throwIfAborted();
	const request = nextRequest++;
	const { kind, logicalName } = slot;
	const message: RequestMessage = {
		type: REQUEST,
		key: slot.key,
		kind,
		logicalName,
		request,
		origin: threadId,
		epoch,
		method,
		args,
		opts: sendableOptions(opts ?? {}),
		accounting: opts?.accounting,
	};
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => finish(signal!.reason, undefined, true);
		const finish = (error: unknown, result?: ModelCallResult<T>, cancel = false) => {
			if (!pendingCalls.delete(request)) return;
			signal?.removeEventListener('abort', onAbort);
			if (timer) clearTimeout(timer);
			if (cancel) {
				try {
					send(owner, { type: CANCEL, key: slot.key, request, origin: threadId } as { type: string });
				} catch {
					// the owner is gone; nothing left to cancel
				}
			}
			if (error === undefined) resolve(result!);
			else reject(error);
		};
		pendingCalls.set(request, { key: slot.key, owner, kind, logicalName, finish: finish as PendingCall['finish'] });
		signal?.addEventListener('abort', onAbort, { once: true });
		if (deadline !== undefined) {
			timer = setTimeout(
				() => finish(new ModelBackendUnavailableError(kind, logicalName, 'timeout'), undefined, true),
				Math.max(0, deadline - Date.now())
			);
			timer.unref?.();
		}
		let sent: boolean;
		try {
			sent = send(owner, message);
		} catch (error) {
			// Structured clone refused part of the call (a function or a native handle in the input).
			finish(
				new ServerError(
					`A '${method}' call to process-wide backend '${kind}.${logicalName}' could not be sent to its owner thread: ${(error as Error)?.message ?? error}`
				)
			);
			return;
		}
		if (!sent) finish(new ModelBackendUnavailableError(kind, logicalName, 'owner-exited'));
	});
}

function onResponse(message: {
	request: number;
	origin: number;
	ok: boolean;
	name?: string;
	result?: ModelCallResult<unknown>;
	error?: WireError;
}): void {
	const pending = pendingCalls.get(message.request);
	// Only the thread the request was sent to may settle it.
	if (!pending || pending.owner !== message.origin) return;
	const slot = slots.get(pending.key);
	if (slot && message.name !== undefined) slot.servedName = message.name;
	if (message.ok) pending.finish(undefined, message.result);
	else pending.finish(fromWireError(message.error, pending.kind, pending.logicalName));
}

// Owner side ----------------------------------------------------------------------------------

function startOwner(slot: Slot, epoch: number): void {
	const current = slot.run;
	if (current && current.epoch >= epoch) return;
	if (current && current.phase !== 'failed') {
		// Re-elected while still holding a backend: keep it rather than building a second one.
		current.epoch = epoch;
		if (current.phase === 'ready') reportStarted(slot, current);
		return;
	}
	const run: OwnerRun = { epoch, phase: 'starting', queue: [], active: 0, running: new Map() };
	slot.run = run;
	void startBackend(slot, run);
}

function isModelBackend(value: unknown): value is ModelBackend {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as ModelBackend).capabilities === 'function' &&
		typeof (value as ModelBackend).name === 'string'
	);
}

async function startBackend(slot: Slot, run: OwnerRun): Promise<void> {
	const { kind, logicalName } = slot;
	let backend: ModelBackend | undefined;
	try {
		let returned: unknown;
		// A factory that registers its own backend (a module factory's `register()`) has that
		// registration captured, not installed: this thread's registry keeps the proxy.
		const constructed = await constructBackend(kind, logicalName, async () => {
			returned = await slot.factory({ kind, logicalName });
		});
		for (const extra of constructed.extras)
			log.warn?.(
				`models: process-wide backend '${kind}.${logicalName}' registered '${extra.kind}.${extra.logicalName}' while starting; only its own registration is kept`
			);
		backend = isModelBackend(returned) ? returned : constructed.backend;
		if (!backend)
			throw new ModelBackendRegistrationError(
				`the factory for process-wide backend '${logicalName}' neither returned a backend nor registered one`
			);
		assertBackendForKind(kind, logicalName, backend);
	} catch (error) {
		if (slot.run !== run) return;
		run.phase = 'failed';
		run.error = error;
		log.error?.(`models: process-wide backend '${kind}.${logicalName}' failed to start on thread ${threadId}`, error);
		const unavailable = toWireError(new ModelBackendUnavailableError(kind, logicalName, 'start-failed'));
		for (const queued of run.queue.splice(0)) respond(queued, { ok: false, error: unavailable });
		send(MAIN_THREAD_ID, {
			type: START_FAILED,
			key: slot.key,
			origin: threadId,
			epoch: run.epoch,
			error: { name: errorName(error), message: errorMessage(error) },
		} as { type: string });
		return;
	}
	if (slot.run !== run) return;
	run.phase = 'ready';
	run.backend = backend;
	reportStarted(slot, run);
	pump(slot, run);
}

function reportStarted(slot: Slot, run: OwnerRun): void {
	const backend = run.backend!;
	send(MAIN_THREAD_ID, {
		type: STARTED,
		key: slot.key,
		origin: threadId,
		epoch: run.epoch,
		name: backend.name,
		capabilities: { ...backend.capabilities() },
	} as { type: string });
}

function requestKey(origin: number, request: number): string {
	return `${origin}:${request}`;
}

function onRequest(message: RequestMessage): void {
	const { kind, logicalName } = message;
	const slot = slots.get(message.key);
	const reply = (error: Error) => respond(message, { ok: false, error: toWireError(error) });
	if (!slot) return reply(new ModelBackendUnavailableError(kind, logicalName, 'not-owner'));
	// A caller sends only to the owner named with its epoch, so a newer epoch is this thread's
	// election, whether this request or main's state push arrives first.
	if (message.epoch > (slot.run?.epoch ?? 0) && !slot.released) startOwner(slot, message.epoch);
	const run = slot.run;
	if (!run) return reply(new ModelBackendUnavailableError(kind, logicalName, 'not-owner'));
	if (run.phase === 'failed') return reply(new ModelBackendUnavailableError(kind, logicalName, 'start-failed'));
	const embedInput = message.method === 'embed' ? message.args[0] : undefined;
	const queued: Queued = {
		origin: message.origin,
		request: message.request,
		method: message.method,
		args: message.args,
		opts: message.opts,
		accounting: message.accounting,
		inputs: Array.isArray(embedInput) ? embedInput.length : 1,
	};
	if (message.method === 'embed' && slot.options.maxBatchInputs > 1) {
		try {
			queued.batchKey = JSON.stringify([message.opts, message.accounting]);
		} catch {
			// options JSON cannot express never merge with anything
		}
	}
	run.queue.push(queued);
	pump(slot, run);
	// What pump could not start waits; past maxPending the newest request is refused, not queued.
	if (run.queue.length > slot.options.maxPending && run.queue[run.queue.length - 1] === queued) {
		run.queue.pop();
		reply(new ModelBackendBusyError(kind, logicalName));
	}
}

function onCancel(message: { key: string; request: number; origin: number }): void {
	const run = slots.get(message.key)?.run;
	if (!run) return;
	const index = run.queue.findIndex((queued) => queued.origin === message.origin && queued.request === message.request);
	if (index !== -1) {
		run.queue.splice(index, 1);
		return;
	}
	const key = requestKey(message.origin, message.request);
	const running = run.running.get(key);
	if (running) cancelMember(running, key);
}

/** A merged call is aborted only once every request in it is cancelled; the others still want it. */
function cancelMember(running: Running, key: string): void {
	running.cancelled.add(key);
	if (running.cancelled.size >= running.members) running.controller.abort();
}

function pump(slot: Slot, run: OwnerRun): void {
	while (run.phase === 'ready' && run.active < slot.options.concurrency && run.queue.length > 0) {
		const batch = takeBatch(slot, run);
		run.active++;
		void execute(slot, run, batch).finally(() => {
			run.active--;
			pump(slot, run);
		});
	}
}

/**
 * The next request, merged with queued `embed` requests that share its options and accounting, up to
 * `maxBatchInputs` inputs. Requests that cannot join keep their places in the queue.
 */
function takeBatch(slot: Slot, run: OwnerRun): Queued[] {
	const first = run.queue.shift()!;
	const limit = slot.options.maxBatchInputs;
	if (first.batchKey === undefined || first.inputs === 0 || first.inputs >= limit) return [first];
	const batch = [first];
	let inputs = first.inputs;
	for (let index = 0; index < run.queue.length && inputs < limit;) {
		const next = run.queue[index];
		if (next.batchKey === first.batchKey && next.inputs > 0 && inputs + next.inputs <= limit) {
			batch.push(next);
			inputs += next.inputs;
			run.queue.splice(index, 1);
		} else index++;
	}
	return batch;
}

function callBackend(backend: ModelBackend, method: Method, args: unknown[], opts: any): Promise<ModelCallResult<any>> {
	const fn = backend[method] as ((...params: unknown[]) => Promise<ModelCallResult<any>>) | undefined;
	if (typeof fn !== 'function') throw new ServerError(`Backend '${backend.name}' does not implement '${method}'`);
	return method === 'decide' || method === 'scoreChoices'
		? fn.call(backend, args[0], args[1], opts)
		: fn.call(backend, args[0], opts);
}

async function execute(slot: Slot, run: OwnerRun, batch: Queued[]): Promise<void> {
	const controller = new AbortController();
	const running: Running = { controller, members: batch.length, cancelled: new Set() };
	for (const queued of batch) run.running.set(requestKey(queued.origin, queued.request), running);
	const name = run.backend!.name;
	try {
		const first = batch[0];
		const opts = { ...first.opts, signal: controller.signal, accounting: first.accounting };
		if (batch.length === 1) {
			const result = await callBackend(run.backend!, first.method, first.args, opts);
			respond(first, { ok: true, name, result }, running);
			return;
		}
		const inputs = batch.flatMap((queued) => queued.args[0] as string | string[]);
		const result = await callBackend(run.backend!, 'embed', [inputs], opts);
		if (result?.status !== 'completed') {
			for (const queued of batch) respond(queued, { ok: true, name, result }, running);
			return;
		}
		const vectors = result.output;
		if (!Array.isArray(vectors) || vectors.length !== inputs.length)
			throw new ServerError(
				`Backend '${run.backend!.name}' returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${inputs.length} inputs`
			);
		const shares = apportionUsage(
			result.usage,
			batch.map((queued) => queued.inputs)
		);
		let offset = 0;
		batch.forEach((queued, index) => {
			const output = vectors.slice(offset, offset + queued.inputs);
			offset += queued.inputs;
			const share = shares[index];
			respond(
				queued,
				{ ok: true, name, result: { status: 'completed', output, ...(share && { usage: share }) } },
				running
			);
		});
	} catch (error) {
		const wire = toWireError(error);
		for (const queued of batch) respond(queued, { ok: false, name, error: wire }, running);
	} finally {
		for (const queued of batch) run.running.delete(requestKey(queued.origin, queued.request));
	}
}

/**
 * Split a merged call's usage by input count. Token counts are divided by largest remainder, so the
 * shares are whole numbers that sum to the reported total and the caller-side rows bill it once;
 * latency is the merged call's for every member.
 */
export function apportionUsage(usage: TokenUsage | undefined, counts: number[]): (TokenUsage | undefined)[] {
	if (!usage || typeof usage !== 'object') return counts.map(() => undefined);
	const total = counts.reduce((sum, count) => sum + count, 0);
	const shares: TokenUsage[] = counts.map(() => ({}));
	for (const field of ['promptTokens', 'completionTokens', 'embeddingTokens'] as const) {
		const value = usage[field];
		if (typeof value !== 'number' || !Number.isFinite(value) || total === 0) continue;
		const exact = counts.map((count) => (value * count) / total);
		const whole = exact.map(Math.floor);
		let left = Math.round(value) - whole.reduce((sum, part) => sum + part, 0);
		const order = exact.map((part, index) => [part - whole[index], index]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
		for (let index = 0; index < order.length && left > 0; index++, left--) whole[order[index][1]]++;
		whole.forEach((part, index) => (shares[index][field] = part));
	}
	if (typeof usage.gpuMs === 'number' && Number.isFinite(usage.gpuMs) && total > 0)
		counts.forEach((count, index) => (shares[index].gpuMs = (usage.gpuMs! * count) / total));
	if (usage.latencyMs !== undefined) for (const share of shares) share.latencyMs = usage.latencyMs;
	return shares;
}

/** Answer `to`, unless its caller cancelled it and so has already settled. */
function respond(
	to: { origin: number; request: number },
	payload: { ok: boolean; name?: string; result?: ModelCallResult<unknown>; error?: WireError },
	running?: Running
): void {
	if (running?.cancelled.has(requestKey(to.origin, to.request))) return;
	try {
		send(to.origin, { type: RESPONSE, request: to.request, origin: threadId, ...payload } as { type: string });
	} catch (error) {
		// The result failed to structured-clone; say so rather than leave the caller waiting.
		const failure = new ServerError(
			`A process-wide backend result could not be returned across threads: ${errorMessage(error)}`
		);
		send(to.origin, {
			type: RESPONSE,
			request: to.request,
			origin: threadId,
			ok: false,
			error: toWireError(failure),
		} as {
			type: string;
		});
	}
}

// Errors cross the thread boundary by name, so the facade classifies and falls back on them exactly
// as it does for a local backend.

function errorName(error: unknown): string {
	return typeof (error as Error)?.name === 'string' ? (error as Error).name : 'Error';
}

function errorMessage(error: unknown): string {
	return typeof (error as Error)?.message === 'string' ? (error as Error).message : String(error);
}

function toWireError(error: unknown): WireError {
	const wire: WireError = { name: errorName(error), message: errorMessage(error) };
	if (!error || typeof error !== 'object') return wire;
	const fields = error as { statusCode?: unknown; code?: unknown; reason?: unknown; usage?: unknown };
	if (typeof fields.statusCode === 'number') wire.statusCode = fields.statusCode;
	if (typeof fields.code === 'string' || typeof fields.code === 'number') wire.code = fields.code;
	if (wire.name === 'ModelBackendUnavailableError' && typeof fields.reason === 'string')
		wire.reason = fields.reason as ModelBackendUnavailableReason;
	if (fields.usage && typeof fields.usage === 'object') {
		const usage: TokenUsage = {};
		for (const [field, value] of Object.entries(fields.usage))
			if (typeof value === 'number' && Number.isFinite(value)) usage[field as keyof TokenUsage] = value;
		wire.usage = usage;
	}
	return wire;
}

function fromWireError(wire: WireError | undefined, kind: ModelKind, logicalName: string): Error {
	if (wire?.name === 'ModelBackendUnavailableError')
		return new ModelBackendUnavailableError(kind, logicalName, wire.reason ?? 'not-owner');
	if (wire?.name === 'ModelBackendBusyError') return new ModelBackendBusyError(kind, logicalName);
	const status = wire?.statusCode;
	const error: Error & { code?: unknown; usage?: TokenUsage } =
		typeof status === 'number' && status >= 400 && status < 500
			? new ClientError(wire!.message, status)
			: new ServerError(wire?.message ?? 'Unknown error', status);
	error.name = wire?.name || 'Error';
	if (wire?.code !== undefined) error.code = wire.code;
	if (wire?.usage) error.usage = wire.usage;
	return error;
}

// ---------------------------------------------------------------------------------------------
// Wiring. Armed at load on every thread that loads the models layer; main loads it at boot, before
// any worker exists, so no claim is ever queued for want of a listener.

listen(CLAIM, onClaim);
listen(RELEASE, onRelease);
listen(STARTED, onStarted);
listen(START_FAILED, onStartFailed);
listen(STATE, onState);
listen(REQUEST, onRequest);
listen(RESPONSE, onResponse);
listen(CANCEL, onCancel);

onThreadExit((deadThreadId: number) => {
	// Calls waiting on a dead owner fail now with a named error; none is retried, since a backend
	// call may already have been billed or applied.
	for (const pending of pendingCalls.values())
		if (pending.owner === deadThreadId)
			pending.finish(new ModelBackendUnavailableError(pending.kind, pending.logicalName, 'owner-exited'));
	for (const slot of slots.values()) {
		// New calls wait for main's next election instead of being sent to the dead owner.
		if (slot.view?.owner === deadThreadId) {
			slot.view = { ...slot.view, owner: undefined, state: slot.view.state === 'failed' ? 'failed' : 'starting' };
			slot.capabilities = BASE_CAPABILITIES[slot.kind];
		}
		// Work for a caller that is gone is dropped if queued and cancelled if running.
		const run = slot.run;
		if (!run) continue;
		run.queue = run.queue.filter((queued) => queued.origin !== deadThreadId);
		for (const [key, running] of run.running) if (key.startsWith(`${deadThreadId}:`)) cancelMember(running, key);
	}
	if (isMainThread) onCoordinatedThreadExit(deadThreadId);
});

if (!isMainThread) {
	// A worker told to shut down hands its claims back first, so the next owner is elected without
	// charging the restart budget; requests it is already running still complete.
	onMessageByType(ITC_EVENT_TYPES.SHUTDOWN, () => {
		for (const slot of slots.values()) {
			if (slot.released) continue;
			slot.released = true;
			send(MAIN_THREAD_ID, { type: RELEASE, key: slot.key, origin: threadId } as { type: string });
		}
	});
}
