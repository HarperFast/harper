/** Process-wide backend protocol. See resources/models/DESIGN.md for its behaviour. */
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
	guardInstalled,
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
/** How many newer states one call may route to after `moved` refusals before it fails as `moved`. */
const MAX_REROUTES = 4;
const MAX_UNCONFIRMED_PAUSE_MS = 50;
const DISPOSE_ATTEMPTS = 3;
const DISPOSE_RETRY_MS = 100;

type Method = 'embed' | 'generate' | 'decide' | 'scoreChoices';
const METHODS: Record<ModelKind, readonly Method[]> = {
	embedding: ['embed'],
	generative: ['generate', 'scoreChoices'],
	decision: ['decide'],
};
type State = 'starting' | 'ready' | 'failed';
type RunPhase = 'starting' | 'ready' | 'draining' | 'disposing' | 'failing' | 'failed' | 'disposed';
interface ResolvedOptions {
	concurrency: number;
	maxPending: number;
	maxRestarts: number;
	ownerWaitMs: number;
	maxBatchInputs?: number;
	timeoutMs?: number;
}
type WireError = {
	name: string;
	message: string;
	statusCode?: number;
	code?: string | number;
	reason?: string;
	usage?: TokenUsage;
	partial?: true;
};
type Refusal = 'moved' | 'unconfirmed' | 'busy' | 'not-owner' | 'start-failed';
class Redirect {
	readonly refusal: 'moved' | 'unconfirmed';
	constructor(refusal: 'moved' | 'unconfirmed') {
		this.refusal = refusal;
	}
}
type ProcessModelBackend = ModelBackend & { dispose?(): unknown };
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
	callers?: number[];
}

interface RequestMessage {
	type: typeof REQUEST;
	key: string;
	kind: ModelKind;
	logicalName: string;
	request: number;
	origin: number;
	version: number;
	epoch: number;
	method: Method;
	args: unknown[];
	opts: Record<string, unknown>;
	accounting: unknown;
}
export class ModelBackendUnavailableError extends ServerError {
	reason: ModelBackendUnavailableReason;
	constructor(kind: ModelKind, logicalName: string, reason: ModelBackendUnavailableReason) {
		super(`Process-wide backend '${kind}.${logicalName}' is unavailable (${reason})`, 503);
		this.name = 'ModelBackendUnavailableError';
		this.reason = reason;
	}
}
export class ModelBackendBusyError extends ServerError {
	constructor(kind: ModelKind, logicalName: string) {
		super(`Process-wide backend '${kind}.${logicalName}' is busy`, 503);
		this.name = 'ModelBackendBusyError';
	}
}

type Handler = (message: any, sender: number, port?: unknown) => void;
const localHandlers = new Map<string, Handler>();
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
		const delivered = structuredClone(message);
		setImmediate(() => {
			try {
				handler?.(delivered, threadId);
			} catch (error) {
				log.error?.(`models: handling '${message.type}' failed`, error);
			}
		});
		return true;
	}
	return threads.sendToThread(target, message);
}
function threadDomain(): string {
	return (workerData as { isolatedApplication?: string } | null)?.isolatedApplication ?? '';
}

function keyFor(kind: ModelKind, logicalName: string): string {
	return JSON.stringify([threadDomain(), kind, logicalName]);
}
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
function currentGeneration(): number {
	return (workerData as { restartNumber?: number } | null)?.restartNumber ?? manageThreads.restartNumber ?? 1;
}
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

interface Claimant {
	generation: number;
	seq: number;
	eligible: boolean;
}

interface Entry {
	key: string;
	claimants: Map<number, Claimant>;
	owner?: number;
	draining?: number;
	epoch: number;
	version: number;
	state: State;
	restarts: number;
	maxRestarts: number;
	generation: number;
	options: ResolvedOptions;
	warnedOptions: boolean;
	name?: string;
	capabilities?: ModelCapabilities;
	reason?: ModelBackendUnavailableReason;
	error?: { name: string; message: string };
}

const entries = new Map<string, Entry>();
let claimSequence = 0;
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
	const domain = keyDomain(key);
	if (domain === undefined || domain !== senderDomain(port)) {
		log.warn?.(
			`models: refused thread ${sender}'s claim of process-wide backend ${String(key)} outside its application`
		);
		return;
	}
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
			`models: process-wide backend ${key} was registered on thread ${sender} with options ${JSON.stringify(options)}, unlike its first registration (${JSON.stringify(entry.options)})`
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
	claimant.eligible = false;
	if (entry.owner === sender) {
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
	log.error?.(`models: process-wide backend ${entry.key} reported a failed disposal on thread ${sender}`);
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
		log.error?.(`models: process-wide backend ${entry.key} lost its owner (${reason}) with no restarts left`);
	}
	publish(entry);
}
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

interface Slot {
	key: string;
	kind: ModelKind;
	logicalName: string;
	factory: ProcessBackendFactory;
	options: ResolvedOptions;
	proxy: ModelBackend;
	view?: StateMessage;
	servedName?: string;
	capabilities: ModelCapabilities;
	waiters: Set<() => void>;
	run?: OwnerRun;
	released: boolean;
	parked: Queued[];
}

interface OwnerRun {
	epoch: number;
	phase: RunPhase;
	backend?: ProcessModelBackend;
	held: Disposable[];
	started?: { name: string; capabilities: ModelCapabilities };
	factorySettled: boolean;
	settled: boolean;
	factoryAbort: AbortController;
	queue: Queued[];
	active: number;
	running: Map<string, Running>;
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
let shuttingDown = false;

const base = (capabilities: Partial<ModelCapabilities>): ModelCapabilities =>
	Object.freeze({ embed: false, generate: false, stream: false, tools: false, adapters: false, ...capabilities });
const BASE_CAPABILITIES: Record<ModelKind, ModelCapabilities> = {
	embedding: base({ embed: true }),
	generative: base({ generate: true }),
	decision: base({ decide: true }),
};
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
		const created = slot;
		guardInstalled(slot.proxy, (late) => divertLate(created, late));
		slots.set(key, slot);
	}
	registerBackend(kind, id, slot.proxy);
	const sent = send(MAIN_THREAD_ID, {
		type: CLAIM,
		key,
		origin: threadId,
		options: resolved,
		eligible: !slot.released && (!isMainThread || getWorkerIndex() === 0),
	} as { type: string });
	if (!sent) log.warn?.(`models: could not reach the main thread to register process-wide backend '${kind}.${id}'`);
}
const divertedLate = new Set<unknown>();
function divertLate(slot: Slot, late: unknown): void {
	const { kind, logicalName } = slot;
	const object = (typeof late === 'object' && late !== null) || typeof late === 'function';
	const run = slot.run;
	if (object && run && isLive(run)) {
		if (run.held.includes(late as Disposable)) {
			log.debug?.(`models: object already held by process-wide backend '${kind}.${logicalName}' was registered again`);
			return;
		}
		log.warn?.(
			`models: registration under process-wide backend '${kind}.${logicalName}' was not installed over its proxy`
		);
		run.held.push(late as Disposable);
		return;
	}
	log.warn?.(
		`models: registration under process-wide backend '${kind}.${logicalName}' was not installed over its proxy`
	);
	if (!object || divertedLate.has(late)) return;
	divertedLate.add(late);
	void disposeOne(slot, late as Disposable)
		.then((undisposed) => {
			if (undisposed)
				log.error?.(
					`models: a registration under process-wide backend '${slot.kind}.${slot.logicalName}' that was not installed could not be disposed`
				);
		})
		.catch(() => undefined)
		.finally(() => divertedLate.delete(late));
}
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
export function callerLoad(kind: ModelKind, id: string): { waiting: number; inFlight: number } | undefined {
	const slot = slots.get(keyFor(kind, id));
	if (!slot) return undefined;
	let inFlight = 0;
	for (const pending of pendingCalls.values()) if (pending.key === slot.key) inFlight++;
	return { waiting: slot.waiters.size, inFlight };
}

function onState(message: StateMessage, sender: number): void {
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

const CALLER_ONLY_OPTIONS = new Set(['signal', 'accounting', 'toolHandlers', 'conversation']);
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
		if (!(outcome instanceof Redirect)) return outcome;
		if (outcome.refusal === 'moved') {
			if (moves++ >= MAX_REROUTES) throw new ModelBackendUnavailableError(kind, logicalName, 'moved');
			after = route.version;
			continue;
		}
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
				} catch {}
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
	if (!pending || pending.owner !== sender) return;
	const { kind, logicalName } = pending;
	const slot = slots.get(pending.key);
	if (slot && typeof message.name === 'string') slot.servedName = message.name;
	if (message.ok === true) return pending.finish(undefined, message.result);
	if (message.refused === undefined) return pending.finish(fromWireError(message.error));
	const refused = message.refused;
	if (refused === 'moved' || refused === 'unconfirmed') pending.finish(undefined, new Redirect(refused));
	else if (refused === 'busy') pending.finish(new ModelBackendBusyError(kind, logicalName));
	else
		pending.finish(
			new ModelBackendUnavailableError(kind, logicalName, refused === 'start-failed' ? 'start-failed' : 'not-owner')
		);
}

function isLive(run: OwnerRun): boolean {
	return run.phase !== 'failed' && run.phase !== 'disposed';
}

function startOwner(slot: Slot, epoch: number): void {
	const current = slot.run;
	if (current && current.epoch >= epoch) return;
	if (current && (current.phase === 'starting' || current.phase === 'ready')) {
		current.epoch = epoch;
		if (current.phase === 'ready') reportStarted(slot, current);
		return;
	}
	if (current && isLive(current)) return;
	const run: OwnerRun = {
		epoch,
		phase: 'starting',
		factorySettled: false,
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
	const hold = (handed: unknown) => {
		const object = (typeof handed === 'object' && handed !== null) || typeof handed === 'function';
		if (object && !run.held.includes(handed as Disposable)) run.held.push(handed as Disposable);
	};
	let undisposed: { error: unknown } | undefined;
	try {
		let returned: unknown;
		const constructed = await constructBackend(
			kind,
			logicalName,
			async () => {
				const result = slot.factory({ kind, logicalName, signal: run.factoryAbort.signal });
				hold(result);
				returned = await result;
				hold(returned);
			},
			{ exclusive: true, hold }
		);
		run.factorySettled = true;
		if (constructed.refused) throw constructed.refused;
		const backend = (isModelBackend(returned) ? returned : constructed.backend) as ProcessModelBackend | undefined;
		if (!backend)
			throw new ModelBackendRegistrationError(
				`the factory for process-wide backend '${logicalName}' neither returned a backend nor registered one`
			);
		run.backend = backend;
		assertBackendForKind(kind, logicalName, backend);
		run.started = structuredClone({ name: backend.name, capabilities: { ...backend.capabilities() } });
		const instance = [constructed.backend, returned];
		for (const extra of constructed.extras)
			log.warn?.(
				`models: process-wide backend '${kind}.${logicalName}' registered '${extra.kind}.${extra.logicalName}' while starting; it was not installed over a registry entry`
			);
		for (const other of run.held.filter((handed) => !instance.includes(handed))) {
			undisposed = (await disposeOne(slot, other)) ?? undisposed;
			run.held = run.held.filter((handed) => handed !== other);
		}
		if (undisposed) throw undisposed.error;
	} catch (error) {
		run.factorySettled = true;
		run.settled = true;
		return failRun(slot, run, error, undisposed);
	}
	run.settled = true;
	if (run.phase === 'draining') return finishDrain(slot, run);
	run.phase = 'ready';
	try {
		reportStarted(slot, run);
	} catch (error) {
		return failRun(slot, run, error);
	}
	pump(slot, run);
}
async function failRun(slot: Slot, run: OwnerRun, error: unknown, earlier?: { error: unknown }): Promise<void> {
	const { kind, logicalName } = slot;
	run.phase = 'failing';
	log.error?.(`models: process-wide backend '${kind}.${logicalName}' failed to start on thread ${threadId}`, error);
	for (const queued of run.queue.splice(0)) refuse(queued, 'start-failed');
	let undisposed = earlier;
	do {
		undisposed = (await disposeInstance(slot, run)) ?? undisposed;
	} while (run.held.length > 0);
	run.phase = 'failed';
	if (undisposed) {
		reportDisposeFailed(slot, undisposed.error);
		run.markDisposed?.();
		return;
	}
	if (slot.released) {
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
async function disposeInstance(slot: Slot, run: OwnerRun): Promise<{ error: unknown } | undefined> {
	run.backend = undefined;
	let undisposed: { error: unknown } | undefined;
	while (run.held.length > 0) {
		const held = run.held[0];
		undisposed = (await disposeOne(slot, held)) ?? undisposed;
		run.held = run.held.filter((handed) => handed !== held);
	}
	return undisposed;
}
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
function reportDisposeFailed(slot: Slot, error: unknown): void {
	send(MAIN_THREAD_ID, {
		type: DISPOSE_FAILED,
		key: slot.key,
		origin: threadId,
		error: { name: errorName(error), message: errorMessage(error) },
	} as { type: string });
}
function beginDrain(slot: Slot, run: OwnerRun): Promise<void> {
	run.disposed ??= new Promise((resolve) => (run.markDisposed = resolve));
	if (run.phase === 'starting' || run.phase === 'ready') {
		run.phase = 'draining';
		if (!run.factorySettled)
			run.factoryAbort.abort(new ModelBackendUnavailableError(slot.kind, slot.logicalName, 'moved'));
		for (const queued of run.queue.splice(0)) refuse(queued, 'moved');
		maybeFinishDrain(slot, run);
	}
	return run.disposed;
}

function maybeFinishDrain(slot: Slot, run: OwnerRun): void {
	if (run.phase === 'draining' && run.active === 0 && run.settled) void finishDrain(slot, run);
}

async function finishDrain(slot: Slot, run: OwnerRun): Promise<void> {
	if (run.phase !== 'draining') return;
	run.phase = 'disposing';
	let undisposed: { error: unknown } | undefined;
	do {
		undisposed = (await disposeInstance(slot, run)) ?? undisposed;
	} while (run.held.length > 0);
	if (undisposed) {
		run.phase = 'failed';
		reportDisposeFailed(slot, undisposed.error);
	} else {
		run.phase = 'disposed';
		send(MAIN_THREAD_ID, { type: DISPOSED, key: slot.key, origin: threadId, epoch: run.epoch } as { type: string });
	}
	run.markDisposed?.();
}
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
function admit(slot: Slot, queued: Queued): void {
	const { kind, logicalName } = slot;
	const view = slot.view;
	if (view !== undefined && queued.epoch < view.epoch) return refuse(queued, 'moved');
	const admitted = queued.origin === threadId || view?.callers?.includes(queued.origin) === true;
	if (!slot.released && (view === undefined || view.version < queued.version)) {
		if (!admitted) return refuse(queued, 'unconfirmed');
		if (slot.parked.length >= slot.options.maxPending) return refuse(queued, 'busy');
		slot.parked.push(queued);
		return;
	}
	const run = slot.run;
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
			`models: refused a call to process-wide backend '${kind}.${logicalName}' from thread ${queued.origin}, which is not in this owner's admitted caller set`
		);
		return refuse(queued, 'not-owner');
	}
	if (queued.method === 'embed' && Array.isArray(queued.args[0])) queued.inputs = queued.args[0].length;
	run.queue.push(queued);
	pump(slot, run);
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
class PartialFailure {
	readonly error: unknown;
	readonly usage: TokenUsage;
	constructor(error: unknown, usage: TokenUsage) {
		this.error = error;
		this.usage = usage;
	}
}
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
function refuse(to: { origin: number; request: number }, refusal: Refusal): void {
	send(to.origin, { type: RESPONSE, request: to.request, origin: threadId, ok: false, refused: refusal } as {
		type: string;
	});
}
function respond(
	to: { origin: number; request: number },
	payload: { ok: boolean; name?: string; result?: ModelCallResult<unknown>; error?: WireError },
	running?: Running
): void {
	if (running?.cancelled.has(requestKey(to.origin, to.request))) return;
	try {
		send(to.origin, { type: RESPONSE, request: to.request, origin: threadId, ...payload } as { type: string });
	} catch (error) {
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
function finiteUsage(reported: object): TokenUsage {
	const usage: TokenUsage = {};
	for (const [field, value] of Object.entries(reported))
		if (typeof value === 'number' && Number.isFinite(value)) usage[field as keyof TokenUsage] = value;
	return usage;
}
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
export function takePartialUsage(error: unknown): TokenUsage | undefined {
	if (typeof error !== 'object' || error === null || !partialUsage.delete(error)) return undefined;
	return (error as { usage?: TokenUsage }).usage;
}

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
	for (const pending of pendingCalls.values())
		if (pending.owner === deadThreadId)
			pending.finish(new ModelBackendUnavailableError(pending.kind, pending.logicalName, 'owner-exited'));
	for (const slot of slots.values()) {
		if (slot.view?.owner === deadThreadId) {
			slot.view = { ...slot.view, owner: undefined, state: slot.view.state === 'failed' ? 'failed' : 'starting' };
			slot.capabilities = BASE_CAPABILITIES[slot.kind];
		}
		slot.parked = slot.parked.filter((queued) => queued.origin !== deadThreadId);
		const run = slot.run;
		if (!run) continue;
		run.queue = run.queue.filter((queued) => queued.origin !== deadThreadId);
		for (const [key, running] of run.running) if (key.startsWith(`${deadThreadId}:`)) cancelMember(running, key);
	}
	if (isMainThread) onCoordinatedThreadExit(deadThreadId);
});

if (!isMainThread) {
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
