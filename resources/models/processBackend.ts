/**
 * Process-wide model backends (`models.registerProcessBackend`): at most one live backend instance
 * per key at a time in a Harper process, built by one owner thread and served to every thread that
 * registered the key.
 *
 * The registry in `backendRegistry.ts` is per thread, so a component that registers an in-process
 * backend builds one per worker: one model, one GPU context and one warmup each. Here every
 * registering thread installs a proxy in its own registry and claims the key from the main thread.
 * Main elects one claimant as owner, only the owner runs the factory, and the proxies forward calls
 * to it over the thread port mesh. See resources/models/DESIGN.md.
 *
 *  - Control plane, worker ⇄ main: CLAIM, RELEASE, STARTED, START_FAILED, DISPOSED and
 *    DISPOSE_FAILED in; STATE out to the claimants. Main holds the only copy of the state and pushes
 *    each change, so the threads' views converge on it; a thread's view can trail it by the push in
 *    flight.
 *  - Data plane, caller ⇄ owner, sibling to sibling and never through main: REQUEST and CANCEL in,
 *    RESPONSE out. A RESPONSE carries a result, the error a backend threw, or a refusal the owner's
 *    admission path sent for a request it never started; only a refusal can send a call again.
 *
 * A handler knows its sender by the port the message arrived on (manageThreads sets a port's thread
 * id when it connects it), never by a field the sender wrote, and drops a message whose `origin`
 * names another thread. Only main's pushes change a thread's view and only main elects: a request
 * names the state it was routed with, and an owner holds a request from a thread main admitted until
 * it has seen that state, and refuses any other at once.
 *
 * Main coordinates because it is never restarted and sees every worker exit. A worker owns because,
 * while there are workers, main loads no application code and the factory is application code. With
 * no worker threads (`threads.count: 0`) main is the worker and owns itself.
 */
import { isMainThread, threadId, workerData } from 'node:worker_threads';
import * as manageThreads from '../../server/threads/manageThreads.js';
import { getWorkerIndex, hasThreadExited, onMessageByType, onThreadExit } from '../../server/threads/manageThreads.js';
import { registerShutdownDrain } from '../../components/shutdownDrain.ts';
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
const DISPOSED = 'models-process-backend-disposed';
const DISPOSE_FAILED = 'models-process-backend-dispose-failed';
const STATE = 'models-process-backend-state';
const REQUEST = 'models-process-backend-request';
const RESPONSE = 'models-process-backend-response';
const CANCEL = 'models-process-backend-cancel';
const MAIN_THREAD_ID = 0;

const DEFAULTS = { concurrency: 1, maxPending: 256, maxRestarts: 1, ownerWaitMs: 30_000 };
/** How many times one call follows the backend after an owner refuses it as `moved`, each time to a newer state. */
const MAX_REROUTES = 4;
/** The longest pause before a call refused as `unconfirmed` is sent again; the pauses double up to it. */
const MAX_UNCONFIRMED_PAUSE_MS = 50;
/** Tries of a backend's `dispose()` before its instance is reported as possibly still live. */
const DISPOSE_ATTEMPTS = 3;
/** The pause before the next try of a rejected `dispose()`, multiplied by the tries so far. */
const DISPOSE_RETRY_MS = 100;

type Method = 'embed' | 'generate' | 'decide' | 'scoreChoices';
/** The methods each kind's proxy forwards; an owner runs no other method a request names. */
const METHODS: Record<ModelKind, readonly Method[]> = {
	embedding: ['embed'],
	generative: ['generate', 'scoreChoices'],
	decision: ['decide'],
};
type State = 'starting' | 'ready' | 'failed';
/**
 * An owner run's lifecycle. It holds a live instance (or a factory that may still produce one) from
 * `starting` until it reaches `failed` or `disposed`; `draining` and `disposing` follow a release,
 * `failing` a failed start.
 */
type RunPhase = 'starting' | 'ready' | 'draining' | 'disposing' | 'failing' | 'failed' | 'disposed';
interface ResolvedOptions {
	concurrency: number;
	maxPending: number;
	maxRestarts: number;
	ownerWaitMs: number;
	maxBatchInputs?: number;
	timeoutMs?: number;
}
/** An error a backend threw (or a call it ran failed with), as it crosses threads. */
type WireError = {
	name: string;
	message: string;
	statusCode?: number;
	code?: string | number;
	reason?: string;
	usage?: TokenUsage;
	/** `usage` is what the completed parts of a split `embed` consumed before a later part failed. */
	partial?: true;
};
/**
 * Why an owner refused a request it never started. Only its admission path sends one, never a call
 * that reached the backend. `moved`: it had released the backend or no longer owns it, so the call
 * follows the backend to a newer state. `unconfirmed`: the request names a state the owner has not
 * seen, from a thread its last state does not admit, so the call is sent again shortly. `busy`,
 * `not-owner` and `start-failed` fail the call.
 */
type Refusal = 'moved' | 'unconfirmed' | 'busy' | 'not-owner' | 'start-failed';
/** A call an owner refused unstarted and the proxy may send again: never a result, never an error. */
class Redirect {
	readonly refusal: 'moved' | 'unconfirmed';
	constructor(refusal: 'moved' | 'unconfirmed') {
		this.refusal = refusal;
	}
}
/** What an owner serves with: the backend a factory built, which may free its resources in `dispose()`. */
type ProcessModelBackend = ModelBackend & { dispose?(): unknown };
/** Something a factory handed its owner that may hold the instance: disposed, if it can be, before the run is gone. */
type Disposable = { dispose?(): unknown };

interface StateMessage {
	type: typeof STATE;
	key: string;
	version: number;
	epoch: number;
	state: State;
	owner?: number;
	draining?: number;
	restarts: number;
	maxRestarts: number;
	generation: number;
	name?: string;
	capabilities?: ModelCapabilities;
	reason?: ModelBackendUnavailableReason;
	error?: { name: string; message: string };
	/** The threads main admitted as claimants of the key; only the owner's copy of a push carries them. */
	callers?: number[];
}

interface RequestMessage {
	type: typeof REQUEST;
	key: string;
	kind: ModelKind;
	logicalName: string;
	request: number;
	origin: number;
	/** The version of main's state the caller routed with; the owner acts on it only once it has seen that state. */
	version: number;
	epoch: number;
	method: Method;
	args: unknown[];
	opts: Record<string, unknown>;
	accounting: unknown;
}

/**
 * A call to a process-wide backend found no owner to serve it; `reason` says why. The message names
 * the backend and the reason only: the error behind a failed start or a lost owner is for operators,
 * in `models.backendStatus`, and is never attached to a caller's error.
 */
export class ModelBackendUnavailableError extends ServerError {
	reason: ModelBackendUnavailableReason;
	constructor(kind: ModelKind, logicalName: string, reason: ModelBackendUnavailableReason) {
		super(`Process-wide backend '${kind}.${logicalName}' is unavailable (${reason})`, 503);
		this.name = 'ModelBackendUnavailableError';
		this.reason = reason;
	}
}

/**
 * The owner of a process-wide backend already holds `maxPending` requests, or `maxPending` calls are
 * already waiting for an owner to be named; retry later.
 */
export class ModelBackendBusyError extends ServerError {
	constructor(kind: ModelKind, logicalName: string) {
		super(`Process-wide backend '${kind}.${logicalName}' is busy`, 503);
		this.name = 'ModelBackendBusyError';
	}
}

// ---------------------------------------------------------------------------------------------
// Messaging. A thread can be its own owner or coordinator (main with no workers, or a worker that
// owns the backend it calls), so a send to this thread is delivered to the local handler, cloned now
// and handled on a later turn as a port would clone and deliver it.

type Handler = (message: any, sender: number, port?: unknown) => void;
const localHandlers = new Map<string, Handler>();

/**
 * Handle `type` from any thread. `sender` is the thread whose port delivered the message, which the
 * sender cannot choose. A message that names another thread as its `origin`, or that arrives with no
 * port, is dropped. manageThreads replays a message that came before any listener without its port,
 * but none of these can: main loads this module before it starts a worker, and every other message
 * goes only to a thread that has registered, and so loaded it.
 */
function listen(type: string, handler: Handler): void {
	localHandlers.set(type, handler);
	onMessageByType(type, (message: any, port?: { threadId?: unknown }) => {
		const sender = port?.threadId;
		if (typeof sender !== 'number' || sender < 0 || (message?.origin !== undefined && message.origin !== sender)) {
			log.warn?.(
				`models: dropped a '${type}' message whose sender could not be confirmed (port thread ${String(sender)}, origin ${String(message?.origin)})`
			);
			return;
		}
		handler(message, sender, port);
	});
}

function send(target: number, message: { type: string }): boolean {
	if (target === threadId) {
		const handler = localHandlers.get(message.type);
		// A structured clone, as postMessage takes, so a call this thread makes to itself is refused,
		// copied and compared exactly as one from another thread is: a value that cannot cross threads
		// throws here, and the handler never shares an object with the sender.
		const delivered = structuredClone(message);
		setImmediate(() => {
			try {
				handler?.(delivered, threadId);
			} catch (error) {
				// The same containment notifyMessageListeners gives a handler a port delivers to.
				log.error?.(`models: handling '${message.type}' failed`, error);
			}
		});
		return true;
	}
	return threads.sendToThread(target, message);
}

/** The application domain of this thread: its isolated application, or '' for the shared pool. */
function threadDomain(): string {
	return (workerData as { isolatedApplication?: string } | null)?.isolatedApplication ?? '';
}

function keyFor(kind: ModelKind, logicalName: string): string {
	// An isolated application's dedicated worker has a registry of its own; keying by its domain keeps
	// its process-wide backends apart from every other application's.
	return JSON.stringify([threadDomain(), kind, logicalName]);
}

/** The domain of the worker main started on the other end of `port`; a self-send is this thread's. */
function senderDomain(port: unknown): string {
	return port === undefined ? threadDomain() : ((port as { application?: string }).application ?? '');
}

function keyDomain(key: unknown): string | undefined {
	if (typeof key !== 'string') return undefined;
	try {
		const parsed = JSON.parse(key);
		return Array.isArray(parsed) && parsed.length === 3 && parsed.every((part) => typeof part === 'string')
			? parsed[0]
			: undefined;
	} catch {
		return undefined;
	}
}

/** The worker generation this thread was started in; `restartWorkers` bumps it, a crash restart does not. */
function currentGeneration(): number {
	return (workerData as { restartNumber?: number } | null)?.restartNumber ?? manageThreads.restartNumber ?? 1;
}

/**
 * Whether two structured-cloned values are equal as primitives (by `Object.is`), arrays and plain
 * objects, field by field. It sees requests as the owner received them, after the clone: a class
 * instance has become a plain object of its own enumerable fields, its prototype dropped, and compares
 * as one, which is also all its backend would get unmerged. An object the clone keeps as its own type
 * (a Date, a Map, a RegExp, a typed array) never compares equal, even to itself, so a request whose
 * options or accounting hold one is never merged. Objects are compared by value only, never by
 * identity: two clones never share one, so identity would merge only calls a thread made to itself.
 */
export function sameValue(a: unknown, b: unknown, depth = 0): boolean {
	const isObject = (value: unknown) => typeof value === 'function' || (typeof value === 'object' && value !== null);
	if (!isObject(a) && !isObject(b)) return Object.is(a, b);
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || depth > 32) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		for (let index = 0; index < a.length; index++) if (!sameValue(a[index], b[index], depth + 1)) return false;
		return true;
	}
	if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	for (const key of keys) {
		if (!Object.hasOwn(b, key)) return false;
		if (!sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth + 1)) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------------------------
// Coordinator (main thread).

interface Claimant {
	/** The generation main started the claimant's worker in (`senderGeneration`), never one its claim names. */
	generation: number;
	seq: number;
	/**
	 * False for main while it has workers, and for a thread that released its claims to shut down. The
	 * claimant states it: a thread can make only itself eligible or not, and main states its own.
	 */
	eligible: boolean;
}

interface Entry {
	key: string;
	/** Every thread main admitted for the key: the ones that may call its owner. */
	claimants: Map<number, Claimant>;
	owner?: number;
	/**
	 * A released owner whose instance may still be live; nothing is elected until it reports DISPOSED
	 * or exits. A thread whose `dispose()` failed stays here until it exits.
	 */
	draining?: number;
	epoch: number;
	version: number;
	state: State;
	restarts: number;
	maxRestarts: number;
	generation: number;
	/** The options of the generation's first claim; a later claim of the generation that differs is logged. */
	options: ResolvedOptions;
	warnedOptions: boolean;
	name?: string;
	capabilities?: ModelCapabilities;
	reason?: ModelBackendUnavailableReason;
	error?: { name: string; message: string };
}

// An entry outlives its claimants: a crash loop that briefly leaves none must not reset its budget.
// There is one per key ever registered, which a component's registrations bound.
const entries = new Map<string, Entry>();
let claimSequence = 0;

/**
 * The worker generation main started the sender's worker in (manageThreads stamps it on the worker);
 * main's own claim is in main's current generation. A claim cannot name its generation, so it cannot
 * win an election over newer workers or clear a failure by claiming to be a deploy's replacement.
 */
function senderGeneration(port: unknown): number {
	const stamped = port === undefined ? currentGeneration() : (port as { restartNumber?: unknown }).restartNumber;
	return Number.isSafeInteger(stamped) ? (stamped as number) : 1;
}

function onClaim(
	message: { key: string; eligible: boolean; options: ResolvedOptions },
	sender: number,
	port?: unknown
): void {
	if (!isMainThread) return;
	const { key } = message;
	// The domain comes from the port main connected, so a worker cannot claim another application's key.
	const domain = keyDomain(key);
	if (domain === undefined || domain !== senderDomain(port)) {
		log.warn?.(
			`models: refused thread ${sender}'s claim of process-wide backend ${String(key)} outside its application`
		);
		return;
	}
	// A claim can lose the race with its thread's exit, which is reported once; ignoring it here keeps
	// a dead thread from ever being elected.
	if (sender !== threadId && hasThreadExited(sender)) return;
	const options = message.options;
	if (!options || typeof options !== 'object' || !Number.isSafeInteger(options.maxRestarts)) {
		log.warn?.(`models: ignored thread ${sender}'s claim of process-wide backend ${key}, whose options are malformed`);
		return;
	}
	const generation = senderGeneration(port);
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
			maxRestarts: options.maxRestarts,
			generation,
			options,
			warnedOptions: false,
		};
		entries.set(key, entry);
	} else if (generation > entry.generation) {
		// An operator restart or a deploy starts a new generation, with a fresh budget, and clears a
		// failure, so a fixed release can serve again. The current owner keeps serving until it leaves.
		entry.generation = generation;
		entry.restarts = 0;
		entry.maxRestarts = options.maxRestarts;
		entry.options = options;
		entry.warnedOptions = false;
		if (entry.state === 'failed') {
			entry.state = 'starting';
			entry.reason = undefined;
			entry.error = undefined;
			changed = true;
		}
	} else if (generation === entry.generation && !entry.warnedOptions && !sameValue(entry.options, options)) {
		entry.warnedOptions = true;
		log.warn?.(
			`models: process-wide backend ${key} was registered on thread ${sender} with options ${JSON.stringify(options)}, unlike its first registration (${JSON.stringify(entry.options)}); the first registration's restart budget applies, and each owner serves with the options it registered`
		);
	}
	entry.claimants.set(sender, {
		generation,
		seq: entry.claimants.get(sender)?.seq ?? claimSequence++,
		eligible: message.eligible === true,
	});
	if (elect(entry)) changed = true;
	publish(entry, changed ? undefined : sender);
}

function onRelease(message: { key: string; live: boolean }, sender: number): void {
	if (!isMainThread) return;
	const entry = entries.get(message.key);
	const claimant = entry?.claimants.get(sender);
	if (!entry || !claimant) return;
	// A thread shutting down stays a caller until it exits, but is never elected again.
	claimant.eligible = false;
	if (entry.owner === sender) {
		// A planned exit: the budget is not charged, and the next owner is elected only once the
		// released instance is gone, so two instances of the key are never live at once.
		entry.owner = undefined;
		entry.name = undefined;
		entry.capabilities = undefined;
		entry.state = 'starting';
		if (message.live === true) entry.draining = sender;
		elect(entry);
	}
	publish(entry);
}

function onDisposed(message: { key: string }, sender: number): void {
	if (!isMainThread) return;
	const entry = entries.get(message.key);
	if (!entry || entry.draining !== sender) return;
	entry.draining = undefined;
	elect(entry);
	publish(entry);
}

/**
 * The owner's `dispose()` rejected on every try, so its instance may still be live. Main keeps that
 * thread as `draining`, so nothing is elected until the thread exits, and fails the key until the
 * next generation, so its calls fail at once instead of waiting for an owner. The error is for
 * operators, in `backendStatus`.
 */
function onDisposeFailed(message: { key: string; error: { name: string; message: string } }, sender: number): void {
	if (!isMainThread) return;
	const entry = entries.get(message.key);
	if (!entry || (entry.owner !== sender && entry.draining !== sender)) return;
	entry.owner = undefined;
	entry.name = undefined;
	entry.capabilities = undefined;
	entry.draining = sender;
	entry.state = 'failed';
	entry.reason = 'dispose-failed';
	entry.error = { name: String(message.error?.name), message: String(message.error?.message) };
	log.error?.(
		`models: process-wide backend ${entry.key} could not dispose its instance on thread ${sender}; no owner is elected while that thread lives, and its calls fail until the next generation`
	);
	publish(entry);
}

function onStarted(
	message: { key: string; epoch: number; name: string; capabilities: ModelCapabilities },
	sender: number
): void {
	if (!isMainThread) return;
	const entry = entries.get(message.key);
	if (!entry || entry.owner !== sender || entry.epoch !== message.epoch || entry.state !== 'starting') return;
	if (typeof message.name !== 'string' || !message.capabilities || typeof message.capabilities !== 'object') return;
	entry.state = 'ready';
	entry.name = message.name;
	entry.capabilities = message.capabilities;
	entry.reason = undefined;
	entry.error = undefined;
	publish(entry);
}

function onStartFailed(
	message: { key: string; epoch: number; error: { name: string; message: string } },
	sender: number
): void {
	if (!isMainThread) return;
	const entry = entries.get(message.key);
	if (!entry || entry.owner !== sender || entry.epoch !== message.epoch) return;
	loseOwner(
		entry,
		'start-failed',
		{ name: String(message.error?.name), message: String(message.error?.message) },
		sender
	);
}

function onCoordinatedThreadExit(deadThreadId: number): void {
	for (const entry of entries.values()) {
		entry.claimants.delete(deadThreadId);
		if (entry.draining === deadThreadId) {
			// The released instance died with its thread; the handover was planned, so it is not charged.
			entry.draining = undefined;
			elect(entry);
			publish(entry);
		} else if (entry.owner === deadThreadId) {
			loseOwner(
				entry,
				'owner-exited',
				{ name: 'ModelBackendUnavailableError', message: `owner thread ${deadThreadId} exited` },
				deadThreadId
			);
		}
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
 * Elect an eligible claimant when there is no owner and no released instance may still be live:
 * newest generation first, then the earliest claim; `avoid` (the owner just lost) only if nobody else
 * is left. With nobody eligible the key is marked `no-owner` (never while a thread drains). Returns
 * whether the state changed.
 */
function elect(entry: Entry, avoid?: number): boolean {
	if (entry.owner !== undefined || entry.draining !== undefined || entry.state === 'failed') return false;
	const preferred = ([a, claimA]: [number, Claimant], [b, claimB]: [number, Claimant]) => {
		if ((a === avoid) !== (b === avoid)) return b === avoid;
		if (claimA.generation !== claimB.generation) return claimA.generation > claimB.generation;
		return claimA.seq < claimB.seq;
	};
	let best: [number, Claimant] | undefined;
	for (const candidate of entry.claimants) {
		if (candidate[1].eligible && (best === undefined || preferred(candidate, best))) best = candidate;
	}
	if (best === undefined) {
		if (entry.reason === 'no-owner') return false;
		entry.reason = 'no-owner';
		return true;
	}
	entry.owner = best[0];
	entry.epoch++;
	entry.state = 'starting';
	entry.name = undefined;
	entry.capabilities = undefined;
	if (entry.reason === 'no-owner') entry.reason = undefined;
	return true;
}

/** Push the entry to every claimant, or to `only`; the owner gets every push, with the callers. */
function publish(entry: Entry, only?: number): void {
	entry.version++;
	const message: StateMessage = {
		type: STATE,
		key: entry.key,
		version: entry.version,
		epoch: entry.epoch,
		state: entry.state,
		owner: entry.owner,
		draining: entry.draining,
		restarts: entry.restarts,
		maxRestarts: entry.maxRestarts,
		generation: entry.generation,
		name: entry.name,
		capabilities: entry.capabilities,
		reason: entry.reason,
		error: entry.error,
	};
	const targets = only === undefined ? [...entry.claimants.keys()] : [only];
	if (entry.owner !== undefined && !targets.includes(entry.owner)) targets.push(entry.owner);
	for (const target of targets) {
		try {
			send(target, target === entry.owner ? { ...message, callers: [...entry.claimants.keys()] } : message);
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
	/** Set once this thread is shutting down: it still calls the backend but never owns it again. */
	released: boolean;
	/** Requests routed with a newer state than this thread has seen, held until main's push arrives. */
	parked: Queued[];
}

interface OwnerRun {
	epoch: number;
	phase: RunPhase;
	/** The backend this run serves with. */
	backend?: ProcessModelBackend;
	/**
	 * Everything the factory handed over: the backend it registered under the key, then what it
	 * returned when that is a different object. Each is disposed before the run counts as gone, so a
	 * module factory that registers its backend and returns the engine behind it frees both.
	 */
	held: Disposable[];
	/** The backend's name and capabilities, read and checked for cloning once, when it started. */
	started?: { name: string; capabilities: ModelCapabilities };
	/** The factory has returned or thrown. */
	settled: boolean;
	/**
	 * Aborted when the run is released while its factory is still running, so a slow load can stop
	 * early. Never once the factory has settled: a backend that keeps the signal is not stopped mid-call.
	 */
	factoryAbort: AbortController;
	queue: Queued[];
	active: number;
	running: Map<string, Running>;
	/** Resolves once a released run's disposal has ended, either way, and main is told how. */
	disposed?: Promise<void>;
	markDisposed?: () => void;
}

interface Queued {
	origin: number;
	request: number;
	version: number;
	epoch: number;
	method: Method;
	args: unknown[];
	opts: Record<string, unknown>;
	accounting: unknown;
	inputs: number;
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
	finish(error: unknown, result?: ModelCallResult<unknown> | Redirect): void;
}

const slots = new Map<string, Slot>();
const pendingCalls = new Map<number, PendingCall>();
let nextRequest = 1;
/** Set when this worker is told to shut down: a registration after that never makes it an owner. */
let shuttingDown = false;

const base = (capabilities: Partial<ModelCapabilities>): ModelCapabilities =>
	Object.freeze({ embed: false, generate: false, stream: false, tools: false, adapters: false, ...capabilities });
/**
 * What a proxy advertises before its owner reports: the one method its kind requires. A call that
 * requires more (tools, scoring, a calibrated decision) fails the facade's capability check until
 * the owner's capabilities arrive.
 */
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
		maxRestarts: positiveInteger(given, 'maxRestarts', 0) ?? DEFAULTS.maxRestarts,
		ownerWaitMs: positiveInteger(given, 'ownerWaitMs', 1) ?? DEFAULTS.ownerWaitMs,
	};
	const maxBatchInputs = positiveInteger(given, 'maxBatchInputs', 1);
	if (maxBatchInputs !== undefined) {
		if (kind !== 'embedding')
			throw new ModelBackendRegistrationError('maxBatchInputs applies to embedding backends only');
		resolved.maxBatchInputs = maxBatchInputs;
	}
	const timeoutMs = positiveInteger(given, 'timeoutMs', 1);
	if (timeoutMs !== undefined) resolved.timeoutMs = timeoutMs;
	return resolved;
}

/**
 * Register `kind`/`id` for the whole process, with at most one live instance at a time. Every thread
 * that loads the component calls this where it would call `registerBackend`; `factory` runs on the
 * elected owner only, and each thread's registry gets a proxy that forwards `embed`, `generate`,
 * `decide` and `scoreChoices` to the owner. Calling it again on a thread updates the factory and
 * options a later start uses and claims again (as a caller only, once the thread is shutting down);
 * a started owner keeps the backend it built.
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
			released: shuttingDown,
			parked: [],
		} as Slot;
		slot.proxy = makeProxy(slot);
		slots.set(key, slot);
	}
	registerBackend(kind, id, slot.proxy);
	const sent = send(MAIN_THREAD_ID, {
		type: CLAIM,
		key,
		origin: threadId,
		options: resolved,
		// Main runs no application code while it has workers; it is eligible only as the lone worker.
		// A thread that is shutting down still claims, to stay a caller, but is never eligible.
		eligible: !slot.released && (!isMainThread || getWorkerIndex() === 0),
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
	if (view?.draining !== undefined) status.draining = view.draining;
	if (view?.generation !== undefined) status.generation = view.generation;
	if (view?.reason !== undefined) status.reason = view.reason;
	if (view?.error !== undefined) status.error = { ...view.error };
	return status;
}

/** Diagnostic: the work this thread holds as owner of `kind`/`id`, or undefined if it holds no run. */
export function ownerLoad(
	kind: ModelKind,
	id: string
): { queued: number; active: number; parked: number; phase: RunPhase; epoch: number; version: number } | undefined {
	const slot = slots.get(keyFor(kind, id));
	const run = slot?.run;
	return (
		run && {
			queued: run.queue.length,
			active: run.active,
			parked: slot.parked.length,
			phase: run.phase,
			epoch: run.epoch,
			version: slot.view?.version ?? 0,
		}
	);
}

/** Diagnostic: this thread's calls to `kind`/`id` waiting for an owner to be named, and sent to one. */
export function callerLoad(kind: ModelKind, id: string): { waiting: number; inFlight: number } | undefined {
	const slot = slots.get(keyFor(kind, id));
	if (!slot) return undefined;
	let inFlight = 0;
	for (const pending of pendingCalls.values()) if (pending.key === slot.key) inFlight++;
	return { waiting: slot.waiters.size, inFlight };
}

function onState(message: StateMessage, sender: number): void {
	// Only main elects; a push from any other thread is not a state.
	if (sender !== MAIN_THREAD_ID) return;
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
	for (const queued of slot.parked.splice(0)) admit(slot, queued);
}

function wake(slot: Slot): void {
	const waiters = [...slot.waiters];
	slot.waiters.clear();
	for (const waiter of waiters) waiter();
}

// Caller side ---------------------------------------------------------------------------------

/**
 * Options a request does not carry as options. The caller's `signal` stays with the caller, which sends
 * a cancel when it aborts. `accounting` is the request's own field, which the owner hands its backend
 * as `opts.accounting`. `toolHandlers` and `conversation` belong to the `toolMode: 'auto'` loop, which
 * runs on the caller.
 */
const CALLER_ONLY_OPTIONS = new Set(['signal', 'accounting', 'toolHandlers', 'conversation']);

/**
 * The options the owner's backend gets: all but the ones above. One whose value structured clone
 * refuses (a function at any depth, a symbol, a WeakMap) fails the call before it waits for an owner,
 * naming the option, rather than being dropped; the same check holds whether the owner is another
 * thread or this one. What the clone leaves out without refusing (a symbol-keyed option or property,
 * a non-enumerable one, a class instance's prototype) is left out, as it is across threads.
 */
function sendableOptions(opts: Record<string, unknown>, describe: () => string): Record<string, unknown> {
	const sendable: Record<string, unknown> = {};
	for (const [field, value] of Object.entries(opts)) {
		if (CALLER_ONLY_OPTIONS.has(field)) continue;
		if (typeof value === 'function')
			throw new ServerError(
				`${describe()} could not be sent to its owner thread: option '${field}' is a function, which cannot cross threads`
			);
		try {
			structuredClone(value);
		} catch (error) {
			throw new ServerError(
				`${describe()} could not be sent to its owner thread: option '${field}' cannot cross threads (${errorMessage(error)})`
			);
		}
		sendable[field] = value;
	}
	return sendable;
}

interface Route {
	owner: number;
	epoch: number;
	version: number;
}

/**
 * The owner to send to, waiting for main to name one (newer than the state `after`, when the last
 * owner refused the call as `moved`). The wait is bounded: past `maxPending` waiting calls a call is refused as
 * busy, and a call that waits `ownerWaitMs` in all fails with `no-owner` (or `timeout`, if the
 * call's own `timeoutMs` ends first). Rejects at once once the backend has failed.
 */
async function routeTo(
	slot: Slot,
	signal: AbortSignal | undefined,
	deadline: number | undefined,
	wait: { until?: number },
	after: number | undefined
): Promise<Route> {
	const { kind, logicalName } = slot;
	for (;;) {
		const view = slot.view;
		if (view?.state === 'failed') throw new ModelBackendUnavailableError(kind, logicalName, 'failed');
		if (view?.owner !== undefined && (after === undefined || view.version > after))
			return { owner: view.owner, epoch: view.epoch, version: view.version };
		if (slot.waiters.size >= slot.options.maxPending) throw new ModelBackendBusyError(kind, logicalName);
		wait.until ??= Date.now() + slot.options.ownerWaitMs;
		const timedOut = deadline !== undefined && deadline <= wait.until;
		const until = timedOut ? deadline : wait.until;
		const expired = () => new ModelBackendUnavailableError(kind, logicalName, timedOut ? 'timeout' : 'no-owner');
		if (Date.now() >= until) throw expired();
		// Each pass waits for a state change, the caller's abort or the bound.
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				slot.waiters.delete(waiter);
				signal?.removeEventListener('abort', onAbort);
				clearTimeout(timer);
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
			const timer = setTimeout(
				() => {
					cleanup();
					reject(expired());
				},
				Math.max(0, until - Date.now())
			);
			timer.unref?.();
		});
	}
}

/** Resolve after `ms`, or reject with the signal's reason when the caller aborts first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal!.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

async function invoke<T>(
	slot: Slot,
	method: Method,
	args: unknown[],
	opts: BackendOpts<Record<string, unknown>>
): Promise<ModelCallResult<T>> {
	const { kind, logicalName } = slot;
	const signal = opts?.signal as AbortSignal | undefined;
	signal?.throwIfAborted();
	const sendable = sendableOptions(
		opts ?? {},
		() => `A '${method}' call to process-wide backend '${kind}.${logicalName}'`
	);
	const deadline = slot.options.timeoutMs === undefined ? undefined : Date.now() + slot.options.timeoutMs;
	const wait: { until?: number } = {};
	let after: number | undefined;
	for (let moves = 0, unconfirmed = 0; ;) {
		const route = await routeTo(slot, signal, deadline, wait, after);
		signal?.throwIfAborted();
		const outcome = await callOwner<T>(slot, route, method, args, sendable, opts?.accounting, signal, deadline);
		// Only a refusal from the owner's admission path is a Redirect: a call that reached the backend
		// settles with its result or its error, whatever that error is named, and is never sent again.
		if (!(outcome instanceof Redirect)) return outcome;
		if (outcome.refusal === 'moved') {
			// The owner had released the backend, or no longer owns it: the call follows the backend to
			// the owner of a newer state.
			if (moves++ >= MAX_REROUTES) throw new ModelBackendUnavailableError(kind, logicalName, 'moved');
			after = route.version;
			continue;
		}
		// The owner had not yet seen the state that admitted this thread; main's push to it is in flight,
		// so the same route is tried again after a short pause, within the call's wait for an owner.
		wait.until ??= Date.now() + slot.options.ownerWaitMs;
		const timedOut = deadline !== undefined && deadline <= wait.until;
		const until = timedOut ? deadline : wait.until;
		if (Date.now() >= until)
			throw new ModelBackendUnavailableError(kind, logicalName, timedOut ? 'timeout' : 'not-owner');
		await pause(Math.min(2 ** unconfirmed++, MAX_UNCONFIRMED_PAUSE_MS, until - Date.now()), signal);
	}
}

function callOwner<T>(
	slot: Slot,
	route: Route,
	method: Method,
	args: unknown[],
	opts: Record<string, unknown>,
	accounting: unknown,
	signal: AbortSignal | undefined,
	deadline: number | undefined
): Promise<ModelCallResult<T> | Redirect> {
	const request = nextRequest++;
	const { kind, logicalName } = slot;
	const { owner } = route;
	const message: RequestMessage = {
		type: REQUEST,
		key: slot.key,
		kind,
		logicalName,
		request,
		origin: threadId,
		version: route.version,
		epoch: route.epoch,
		method,
		args,
		opts,
		accounting,
	};
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => finish(signal!.reason, undefined, true);
		const finish = (error: unknown, result?: ModelCallResult<T> | Redirect, cancel = false) => {
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

function onResponse(
	message: {
		request: number;
		ok: boolean;
		name?: string;
		result?: ModelCallResult<unknown>;
		error?: WireError;
		refused?: unknown;
	},
	sender: number
): void {
	const pending = pendingCalls.get(message.request);
	// Only the thread the request was sent to may settle it.
	if (!pending || pending.owner !== sender) return;
	const { kind, logicalName } = pending;
	const slot = slots.get(pending.key);
	if (slot && typeof message.name === 'string') slot.servedName = message.name;
	if (message.ok === true) return pending.finish(undefined, message.result);
	if (message.refused === undefined) return pending.finish(fromWireError(message.error));
	// A refusal is the owner's word that the call never started; only a refusal may send it again.
	const refused = message.refused;
	if (refused === 'moved' || refused === 'unconfirmed') pending.finish(undefined, new Redirect(refused));
	else if (refused === 'busy') pending.finish(new ModelBackendBusyError(kind, logicalName));
	else
		pending.finish(
			new ModelBackendUnavailableError(kind, logicalName, refused === 'start-failed' ? 'start-failed' : 'not-owner')
		);
}

// Owner side ----------------------------------------------------------------------------------

function isLive(run: OwnerRun): boolean {
	return run.phase !== 'failed' && run.phase !== 'disposed';
}

function startOwner(slot: Slot, epoch: number): void {
	const current = slot.run;
	if (current && current.epoch >= epoch) return;
	if (current && (current.phase === 'starting' || current.phase === 'ready')) {
		// Re-elected while it still holds an instance: keep it rather than build a second one.
		current.epoch = epoch;
		if (current.phase === 'ready') reportStarted(slot, current);
		return;
	}
	// A run that is releasing or failing still holds its instance; main does not elect such a thread.
	if (current && isLive(current)) return;
	const run: OwnerRun = {
		epoch,
		phase: 'starting',
		settled: false,
		factoryAbort: new AbortController(),
		held: [],
		queue: [],
		active: 0,
		running: new Map(),
	};
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
	try {
		let returned: unknown;
		// A factory that registers its own backend (a module factory's `register()`) has that
		// registration captured, not installed: this thread's registry keeps the proxy. Any other
		// backend it registers while starting is discarded.
		const constructed = await constructBackend(kind, logicalName, async () => {
			returned = await slot.factory({ kind, logicalName, signal: run.factoryAbort.signal });
		});
		// Everything the factory handed over is held before any of its properties is read, so a check
		// below that fails, even a getter that throws, still disposes all of it before main hears of the
		// failure: the backend it registered, and what it returned when that is a different object.
		for (const handed of [constructed.backend, returned])
			if (typeof handed === 'object' && handed !== null && !run.held.includes(handed)) run.held.push(handed);
		for (const extra of constructed.extras)
			log.warn?.(
				`models: process-wide backend '${kind}.${logicalName}' registered '${extra.kind}.${extra.logicalName}' while starting; it is discarded and only its own registration is kept`
			);
		const backend = (isModelBackend(returned) ? returned : constructed.backend) as ProcessModelBackend | undefined;
		if (!backend)
			throw new ModelBackendRegistrationError(
				`the factory for process-wide backend '${logicalName}' neither returned a backend nor registered one`
			);
		run.backend = backend;
		assertBackendForKind(kind, logicalName, backend);
		// Read inside the start, so a capabilities() that throws, or that returns something that
		// cannot cross threads, is a failed start rather than a run that never reports.
		run.started = structuredClone({ name: backend.name, capabilities: { ...backend.capabilities() } });
	} catch (error) {
		run.settled = true;
		return failRun(slot, run, error);
	}
	run.settled = true;
	// Released while it was starting: nothing ran, so the instance is disposed at once.
	if (run.phase === 'draining') return finishDrain(slot, run);
	run.phase = 'ready';
	try {
		reportStarted(slot, run);
	} catch (error) {
		return failRun(slot, run, error);
	}
	pump(slot, run);
}

/**
 * A failed start: fail the calls waiting on this run, dispose any instance the factory built, and
 * only then tell main, which may elect another owner, so the failure never leaves two instances.
 */
async function failRun(slot: Slot, run: OwnerRun, error: unknown): Promise<void> {
	const { kind, logicalName } = slot;
	run.phase = 'failing';
	log.error?.(`models: process-wide backend '${kind}.${logicalName}' failed to start on thread ${threadId}`, error);
	for (const queued of run.queue.splice(0)) refuse(queued, 'start-failed');
	const undisposed = await disposeInstance(slot, run);
	run.phase = 'failed';
	if (undisposed) {
		reportDisposeFailed(slot, undisposed.error);
		run.markDisposed?.();
		return;
	}
	if (slot.released) {
		// Main holds this released run as draining; the instance is gone either way.
		send(MAIN_THREAD_ID, { type: DISPOSED, key: slot.key, origin: threadId, epoch: run.epoch } as { type: string });
		run.markDisposed?.();
		return;
	}
	send(MAIN_THREAD_ID, {
		type: START_FAILED,
		key: slot.key,
		origin: threadId,
		epoch: run.epoch,
		error: { name: errorName(error), message: errorMessage(error) },
	} as { type: string });
}

function reportStarted(slot: Slot, run: OwnerRun): void {
	send(MAIN_THREAD_ID, {
		type: STARTED,
		key: slot.key,
		origin: threadId,
		epoch: run.epoch,
		...run.started!,
	} as { type: string });
}

/**
 * Dispose the run's instance: everything the factory handed over (`held`), in turn. Resolves to
 * undefined once each one is disposed, or to an error when one could not be: the instance may still
 * be live. Every one is tried, whatever happened to the others.
 */
async function disposeInstance(slot: Slot, run: OwnerRun): Promise<{ error: unknown } | undefined> {
	run.backend = undefined;
	let undisposed: { error: unknown } | undefined;
	for (const held of run.held.splice(0)) undisposed = (await disposeOne(slot, held)) ?? undisposed;
	return undisposed;
}

/**
 * Try `held`'s `dispose()` up to `DISPOSE_ATTEMPTS` times, pausing between tries. Resolves to
 * undefined once a try resolves, or at once for an object without `dispose()`, which is taken to hold
 * nothing its finished calls and its thread's exit do not release. Resolves to the last error when
 * every try rejects. A `dispose` property that throws when read counts as a try that rejected.
 */
async function disposeOne(slot: Slot, held: Disposable): Promise<{ error: unknown } | undefined> {
	let failure: unknown;
	for (let attempt = 1; attempt <= DISPOSE_ATTEMPTS; attempt++) {
		try {
			const dispose = held.dispose;
			if (typeof dispose !== 'function') return undefined;
			await dispose.call(held);
			return undefined;
		} catch (error) {
			failure = error;
			log.error?.(
				`models: disposing process-wide backend '${slot.kind}.${slot.logicalName}' failed (try ${attempt} of ${DISPOSE_ATTEMPTS})`,
				error
			);
		}
		if (attempt < DISPOSE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, DISPOSE_RETRY_MS * attempt));
	}
	return { error: failure };
}

/** Tell main this thread's instance of the key may still be live, so it elects no successor while the thread lives. */
function reportDisposeFailed(slot: Slot, error: unknown): void {
	send(MAIN_THREAD_ID, {
		type: DISPOSE_FAILED,
		key: slot.key,
		origin: threadId,
		error: { name: errorName(error), message: errorMessage(error) },
	} as { type: string });
}

/**
 * Stop a released run accepting work: what has not started follows the backend to the next owner
 * (`moved`), running calls finish, and then the instance is disposed and main told. Resolves once
 * main has been told how disposal ended.
 */
function beginDrain(slot: Slot, run: OwnerRun): Promise<void> {
	run.disposed ??= new Promise((resolve) => (run.markDisposed = resolve));
	if (run.phase === 'starting' || run.phase === 'ready') {
		run.phase = 'draining';
		// Only a factory still running is told to stop; a ready backend's calls run to the end.
		if (!run.settled) run.factoryAbort.abort(new ModelBackendUnavailableError(slot.kind, slot.logicalName, 'moved'));
		for (const queued of run.queue.splice(0)) refuse(queued, 'moved');
		maybeFinishDrain(slot, run);
	}
	// A failing run reports its own disposal once its instance is gone (failRun).
	return run.disposed;
}

function maybeFinishDrain(slot: Slot, run: OwnerRun): void {
	if (run.phase === 'draining' && run.active === 0 && run.settled) void finishDrain(slot, run);
}

async function finishDrain(slot: Slot, run: OwnerRun): Promise<void> {
	if (run.phase !== 'draining') return;
	run.phase = 'disposing';
	const undisposed = await disposeInstance(slot, run);
	if (undisposed) {
		run.phase = 'failed';
		reportDisposeFailed(slot, undisposed.error);
	} else {
		run.phase = 'disposed';
		send(MAIN_THREAD_ID, { type: DISPOSED, key: slot.key, origin: threadId, epoch: run.epoch } as { type: string });
	}
	run.markDisposed?.();
}

/**
 * Hand back every claim this thread holds, because it is shutting down, and drain what it owns.
 * Resolves once disposal of every instance it held has ended.
 */
function releaseAll(): Promise<void> {
	shuttingDown = true;
	const disposals: Promise<void>[] = [];
	for (const slot of slots.values()) {
		if (!slot.released) {
			slot.released = true;
			const run = slot.run;
			const live = run !== undefined && isLive(run);
			send(MAIN_THREAD_ID, { type: RELEASE, key: slot.key, origin: threadId, live } as { type: string });
			for (const queued of slot.parked.splice(0)) refuse(queued, 'moved');
			if (run && live) beginDrain(slot, run);
		}
		if (slot.run?.disposed) disposals.push(slot.run.disposed);
	}
	return Promise.all(disposals).then(() => undefined);
}

function requestKey(origin: number, request: number): string {
	return `${origin}:${request}`;
}

function onRequest(message: RequestMessage, sender: number): void {
	if (!Number.isSafeInteger(message.request)) return;
	const slot = slots.get(message.key);
	const queued: Queued = {
		origin: sender,
		request: message.request,
		version: message.version,
		epoch: message.epoch,
		method: message.method,
		args: message.args,
		opts: message.opts,
		accounting: message.accounting,
		inputs: 1,
	};
	if (
		!slot ||
		!Number.isSafeInteger(message.version) ||
		!Number.isSafeInteger(message.epoch) ||
		!METHODS[slot.kind].includes(message.method) ||
		!Array.isArray(message.args) ||
		typeof message.opts !== 'object' ||
		message.opts === null
	)
		return refuse(queued, 'not-owner');
	admit(slot, queued);
}

/**
 * Queue a request this thread may serve now, hold one from an admitted thread routed with a state it
 * has not seen, and refuse the rest unstarted. A request routed with an older election than this
 * thread has seen is refused `moved` first, whatever version it names, so it is never held. Main's
 * admitted callers are checked before a request is held, so a thread main never admitted cannot
 * occupy the hold whatever version it names. A thread main admitted after this thread's last state is
 * refused `unconfirmed` and tries again.
 */
function admit(slot: Slot, queued: Queued): void {
	const { kind, logicalName } = slot;
	const view = slot.view;
	// Main's epoch never falls as its version rises, so no state this thread will see serves an older
	// election: the caller follows the backend to the owner of a newer state.
	if (view !== undefined && queued.epoch < view.epoch) return refuse(queued, 'moved');
	// Only a thread main admitted for this key may call it, which holds an application's domain here.
	const admitted = queued.origin === threadId || view?.callers?.includes(queued.origin) === true;
	if (!slot.released && (view === undefined || view.version < queued.version)) {
		if (!admitted) return refuse(queued, 'unconfirmed');
		if (slot.parked.length >= slot.options.maxPending) return refuse(queued, 'busy');
		slot.parked.push(queued);
		return;
	}
	const run = slot.run;
	// Released, or not the owner of the election the request was routed with: the request never ran,
	// and the caller follows the backend to the owner of a newer state.
	if (
		slot.released ||
		view?.owner !== threadId ||
		queued.epoch !== view.epoch ||
		!run ||
		run.phase === 'draining' ||
		run.phase === 'disposing'
	)
		return refuse(queued, 'moved');
	if (run.phase !== 'starting' && run.phase !== 'ready') return refuse(queued, 'start-failed');
	if (!admitted) {
		log.warn?.(
			`models: refused a call to process-wide backend '${kind}.${logicalName}' from thread ${queued.origin}, which never registered it`
		);
		return refuse(queued, 'not-owner');
	}
	if (queued.method === 'embed' && Array.isArray(queued.args[0])) queued.inputs = queued.args[0].length;
	run.queue.push(queued);
	pump(slot, run);
	// What pump could not start waits; past maxPending the newest request is refused, not queued.
	if (run.queue.length > slot.options.maxPending && run.queue[run.queue.length - 1] === queued) {
		run.queue.pop();
		refuse(queued, 'busy');
	}
}

function onCancel(message: { key: string; request: number }, sender: number): void {
	const slot = slots.get(message.key);
	if (!slot) return;
	const matches = (queued: Queued) => queued.origin === sender && queued.request === message.request;
	const parked = slot.parked.findIndex(matches);
	if (parked !== -1) {
		slot.parked.splice(parked, 1);
		return;
	}
	const run = slot.run;
	if (!run) return;
	const index = run.queue.findIndex(matches);
	if (index !== -1) {
		run.queue.splice(index, 1);
		return;
	}
	const key = requestKey(sender, message.request);
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
			if (run.phase === 'ready') pump(slot, run);
			else maybeFinishDrain(slot, run);
		});
	}
}

/**
 * The next request, merged with queued `embed` requests whose options and accounting are equal by
 * `sameValue`, up to `maxBatchInputs` inputs. Requests that cannot join keep their places.
 */
function takeBatch(slot: Slot, run: OwnerRun): Queued[] {
	const first = run.queue.shift()!;
	const limit = slot.options.maxBatchInputs;
	if (limit === undefined || first.method !== 'embed' || first.inputs === 0 || first.inputs >= limit) return [first];
	const batch = [first];
	let inputs = first.inputs;
	for (let index = 0; index < run.queue.length && inputs < limit;) {
		const next = run.queue[index];
		if (
			next.method === 'embed' &&
			next.inputs > 0 &&
			inputs + next.inputs <= limit &&
			sameValue(next.opts, first.opts) &&
			sameValue(next.accounting, first.accounting)
		) {
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

function vectorCountError(backend: ModelBackend, vectors: unknown, inputs: number): ServerError {
	return new ServerError(
		`Backend '${backend.name}' returned ${Array.isArray(vectors) ? vectors.length : 'no'} vectors for ${inputs} inputs`
	);
}

/** A split `embed` failed after parts of it completed: the failure, and what the completed parts used. */
class PartialFailure {
	readonly error: unknown;
	readonly usage: TokenUsage;
	constructor(error: unknown, usage: TokenUsage) {
		this.error = error;
		this.usage = usage;
	}
}

/**
 * One request with more inputs than `maxBatchInputs`, run as consecutive calls of at most that many.
 * When a part fails after others completed, it throws a PartialFailure carrying their usage, so the
 * caller's row bills what the backend did.
 */
async function embedInParts(
	backend: ModelBackend,
	inputs: string[],
	opts: Record<string, unknown>,
	limit: number,
	signal: AbortSignal
): Promise<ModelCallResult<unknown[]>> {
	const output: unknown[] = [];
	let usage: TokenUsage | undefined;
	try {
		for (let offset = 0; offset < inputs.length; offset += limit) {
			signal.throwIfAborted();
			const part = inputs.slice(offset, offset + limit);
			const result = await callBackend(backend, 'embed', [part], opts);
			if (result?.status !== 'completed')
				throw new ServerError(
					`Backend '${backend.name}' answered part of an embed request split at maxBatchInputs with a '${String(result?.status)}' result`
				);
			// A part that completed was done, even if its vectors are then refused.
			usage = addUsage(usage, result.usage);
			if (!Array.isArray(result.output) || result.output.length !== part.length)
				throw vectorCountError(backend, result.output, part.length);
			output.push(...result.output);
		}
	} catch (error) {
		throw usage ? new PartialFailure(error, usage) : error;
	}
	return { status: 'completed', output, ...(usage && { usage }) };
}

const USAGE_FIELDS = ['promptTokens', 'completionTokens', 'embeddingTokens', 'gpuMs', 'latencyMs'] as const;

/** The usage of consecutive calls: every field summed, latency included, since they ran one after another. */
function addUsage(total: TokenUsage | undefined, part: TokenUsage | undefined): TokenUsage | undefined {
	if (!part || typeof part !== 'object') return total;
	const sum: TokenUsage = { ...total };
	for (const field of USAGE_FIELDS) {
		const value = part[field];
		if (typeof value === 'number' && Number.isFinite(value)) sum[field] = (sum[field] ?? 0) + value;
	}
	return sum;
}

async function execute(slot: Slot, run: OwnerRun, batch: Queued[]): Promise<void> {
	const backend = run.backend!;
	const name = run.started!.name;
	const controller = new AbortController();
	const running: Running = { controller, members: batch.length, cancelled: new Set() };
	for (const queued of batch) run.running.set(requestKey(queued.origin, queued.request), running);
	try {
		const first = batch[0];
		const opts = { ...first.opts, signal: controller.signal, accounting: first.accounting };
		const limit = slot.options.maxBatchInputs;
		if (batch.length === 1) {
			const result =
				first.method === 'embed' && limit !== undefined && first.inputs > limit
					? await embedInParts(backend, first.args[0] as string[], opts, limit, controller.signal)
					: await callBackend(backend, first.method, first.args, opts);
			respond(first, { ok: true, name, result }, running);
			return;
		}
		const inputs = batch.flatMap((queued) => queued.args[0] as string | string[]);
		const result = await callBackend(backend, 'embed', [inputs], opts);
		if (result?.status !== 'completed') {
			// Passed whole to every member: the facade refuses a non-completed embed result.
			for (const queued of batch) respond(queued, { ok: true, name, result }, running);
			return;
		}
		const vectors = result.output;
		if (!Array.isArray(vectors) || vectors.length !== inputs.length)
			throw vectorCountError(backend, vectors, inputs.length);
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
		const wire = toWireError(error instanceof PartialFailure ? error.error : error);
		if (error instanceof PartialFailure) {
			wire.usage = finiteUsage(error.usage);
			wire.partial = true;
		}
		for (const queued of batch) respond(queued, { ok: false, name, error: wire }, running);
	} finally {
		for (const queued of batch) run.running.delete(requestKey(queued.origin, queued.request));
	}
}

/**
 * Split a merged call's usage by input count, so the caller-side rows bill it once: each count is
 * split so that the shares add up to exactly the reported value, in whatever order they are added
 * (see `splitExactly`). Latency is the merged call's for every member, not a share.
 */
export function apportionUsage(usage: TokenUsage | undefined, counts: number[]): (TokenUsage | undefined)[] {
	if (!usage || typeof usage !== 'object') return counts.map(() => undefined);
	const total = counts.reduce((sum, count) => sum + count, 0);
	const shares: TokenUsage[] = counts.map(() => ({}));
	for (const field of ['promptTokens', 'completionTokens', 'embeddingTokens', 'gpuMs'] as const) {
		const value = usage[field];
		if (typeof value !== 'number' || !Number.isFinite(value) || total === 0) continue;
		splitExactly(value, counts, total).forEach((part, index) => (shares[index][field] = part));
	}
	if (usage.latencyMs !== undefined) for (const share of shares) share.latencyMs = usage.latencyMs;
	return shares;
}

/**
 * Split `value` in proportion to `counts` (summing to `total`) into parts that add up to exactly
 * `value` in any order. The whole part is divided by largest remainder, in integer arithmetic. The
 * fractional part, which `value - floor(value)` gives exactly, joins the largest share: an integer
 * no larger than `floor(value)` plus that fraction is a multiple of `value`'s unit in the last place
 * below `value`, so it, and every partial sum of the parts, is exactly representable. A negative
 * value, or one too large to split exactly, is not split: the first member carries it whole.
 */
function splitExactly(value: number, counts: number[], total: number): number[] {
	const parts = counts.map(() => 0);
	const whole = Math.floor(value);
	if (value < 0 || !Number.isSafeInteger(whole * total)) {
		parts[0] = value;
		return parts;
	}
	const remainders = counts.map((count, index) => {
		const product = whole * count;
		let quotient = Math.floor(product / total);
		let remainder = product - quotient * total;
		if (remainder < 0) {
			quotient--;
			remainder += total;
		} else if (remainder >= total) {
			quotient++;
			remainder -= total;
		}
		parts[index] = quotient;
		return [remainder, index];
	});
	let left = whole - parts.reduce((sum, part) => sum + part, 0);
	remainders.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
	for (let index = 0; index < remainders.length && left > 0; index++, left--) parts[remainders[index][1]]++;
	let largest = 0;
	for (let index = 1; index < parts.length; index++) if (parts[index] > parts[largest]) largest = index;
	parts[largest] += value - whole;
	return parts;
}

/**
 * Refuse `to` unstarted. Only admission, a drain and a failed start call this, each for a request
 * that never reached the backend; the caller's proxy may send it again on `moved` or `unconfirmed`,
 * and on nothing else. `execute`, which runs the backend, answers only through `respond`.
 */
function refuse(to: { origin: number; request: number }, refusal: Refusal): void {
	send(to.origin, { type: RESPONSE, request: to.request, origin: threadId, ok: false, refused: refusal } as {
		type: string;
	});
}

/** Answer `to` with what the backend did, unless its caller cancelled it and so has already settled. */
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

// A backend's errors cross the thread boundary by name, so the facade classifies and falls back on
// them exactly as it does for a local backend. They are rebuilt as plain errors of that name: the
// proxy's own error classes are only for what the proxy and the protocol decide.

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
	if (wire.name === 'ModelBackendUnavailableError' && typeof fields.reason === 'string') wire.reason = fields.reason;
	if (fields.usage && typeof fields.usage === 'object') wire.usage = finiteUsage(fields.usage);
	return wire;
}

/** A usage's finite numeric fields, as a plain object that crosses threads. */
function finiteUsage(reported: object): TokenUsage {
	const usage: TokenUsage = {};
	for (const [field, value] of Object.entries(reported))
		if (typeof value === 'number' && Number.isFinite(value)) usage[field as keyof TokenUsage] = value;
	return usage;
}

/** Caller-side errors whose `usage` is a split embed's completed parts, not yet billed by the facade. */
const partialUsage = new WeakSet<object>();

function fromWireError(wire: WireError | undefined): Error {
	const status = wire?.statusCode;
	const error: Error & { code?: unknown; reason?: string; usage?: TokenUsage } =
		typeof status === 'number' && status >= 400 && status < 500
			? new ClientError(wire!.message, status)
			: new ServerError(wire?.message ?? 'Unknown error', status);
	error.name = wire?.name || 'Error';
	if (wire?.code !== undefined) error.code = wire.code;
	if (wire?.reason !== undefined) error.reason = wire.reason;
	if (wire?.usage) {
		error.usage = wire.usage;
		if (wire.partial === true) partialUsage.add(error);
	}
	return error;
}

/**
 * The usage a process-wide backend's split `embed` consumed in the parts that completed before a later
 * part failed, from the error the call rejected with (its `usage`). It is returned once per error, to
 * the facade's row for that attempt, so an error that travels on is never billed twice.
 */
export function takePartialUsage(error: unknown): TokenUsage | undefined {
	if (typeof error !== 'object' || error === null || !partialUsage.delete(error)) return undefined;
	return (error as { usage?: TokenUsage }).usage;
}

// ---------------------------------------------------------------------------------------------
// Wiring. Armed at load on every thread that loads the models layer; main loads it at boot, before
// any worker exists, so no claim is ever queued for want of a listener.

listen(CLAIM, onClaim);
listen(RELEASE, onRelease);
listen(STARTED, onStarted);
listen(START_FAILED, onStartFailed);
listen(DISPOSED, onDisposed);
listen(DISPOSE_FAILED, onDisposeFailed);
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
		// Work for a caller that is gone is dropped if queued or held and cancelled if running.
		slot.parked = slot.parked.filter((queued) => queued.origin !== deadThreadId);
		const run = slot.run;
		if (!run) continue;
		run.queue = run.queue.filter((queued) => queued.origin !== deadThreadId);
		for (const [key, running] of run.running) if (key.startsWith(`${deadThreadId}:`)) cancelMember(running, key);
	}
	if (isMainThread) onCoordinatedThreadExit(deadThreadId);
});

if (!isMainThread) {
	// A worker told to shut down hands its claims back first. An instance it owns stops taking new
	// work, finishes what is running and is disposed before main elects the next owner, and Harper's
	// shutdown drain (threadServer) waits for that before the worker closes its servers and exits.
	registerShutdownDrain({
		hasWork() {
			for (const slot of slots.values()) if (slot.run && isLive(slot.run)) return true;
			return false;
		},
		drain: () => releaseAll(),
	});
	onMessageByType(ITC_EVENT_TYPES.SHUTDOWN, (_message: unknown, port?: { threadId?: unknown }) => {
		if (port?.threadId !== MAIN_THREAD_ID) return;
		void releaseAll();
	});
}
