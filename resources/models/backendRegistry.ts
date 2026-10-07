import { AsyncLocalStorage } from 'node:async_hooks';
import { ServerError } from '../../utility/errors/hdbError.ts';
import type {
	DefineBackendSpec,
	GenerateResult,
	ModelBackend,
	ModelCapabilities,
	ModelKind,
	ToolCall,
} from './types.ts';

/**
 * Process-wide model backend registry.
 *
 * Stores logical-name → backend-instance mappings for embedding and
 * generative kinds. Boot wiring populates the registry via
 * `setEmbedding(...)` / `setGenerative(...)`; the `Models` facade reads it
 * via `resolveEmbedding(...)` / `resolveGenerative(...)`.
 *
 * Components and apps register their own backends — including in-process /
 * non-HTTP ones — through the public `registerBackend(...)` / `defineBackend(...)`
 * pair (#1325), the same primitive the built-in backends use internally.
 *
 * Module-scope state is intentional — one registry per Harper process,
 * mirroring `contextStorage` at `resources/transaction.ts:6`. Translating
 * a YAML `models:` config block into registry entries (the bootstrapper
 * step) lands in Phase 2 alongside the first real backend.
 */

const registries: Record<ModelKind, Map<string, ModelBackend>> = {
	embedding: new Map(),
	generative: new Map(),
	decision: new Map(),
};

/** A registration a factory made during construction, deferred to the caller. */
export interface CapturedInstall {
	kind: ModelKind;
	logicalName: string;
	backend: ModelBackend;
}

interface CaptureSlot {
	kind: ModelKind;
	logicalName: string;
	backend?: ModelBackend;
	/** Deferred with the primary, so no request observes a new helper next to an old primary. */
	extras: CapturedInstall[];
	/** Async work spawned by a factory retains the ALS context past construction; once construction
	 * ends the scope deactivates, so a later registration is not captured: it is handled as any
	 * registration outside a capture, installed, or diverted under a key `guardInstalled` keeps. */
	active: boolean;
	/** Refuse a second registration under the slot's own key (`constructBackend`'s `exclusive`). */
	exclusive: boolean;
	/** That refusal, kept so it fails the construction whatever the registering code does with it. */
	refused?: ModelBackendRegistrationError;
	/** `constructBackend`'s `hold`: given each object registered in the scope before it is checked or refused. */
	hold?: (handed: object) => void;
	/** What `hold` has been given, so it is given each object once. */
	handed: Set<unknown>;
}

const sources = new WeakMap<ModelBackend, string>();

/**
 * An internal option key: the decision adapter passes a hook under it on inner calls, and the facade
 * reports each successful attempt's source through it. A symbol, so it is never part of the public options.
 */
export const SERVED_SOURCE = Symbol('models.servedSource');
export type ServedSourceHook = (source: string | undefined) => void;

export function setBackendSource(backend: ModelBackend, fingerprint: string): void {
	sources.set(backend, fingerprint);
}

export function getBackendSource(backend: ModelBackend): string | undefined {
	return sources.get(backend);
}

// Async-context scoped: a module-global slot would divert unrelated registrations and collide
// concurrent constructions.
const captureScope = new AsyncLocalStorage<CaptureSlot>();

/**
 * Give `value` to the active capture's `hold`, if it has one and has not been given `value` yet, before
 * anything checks or refuses it, so the capturing caller owns it whatever happens next. Reads nothing
 * of `value`.
 */
function handOver(slot: CaptureSlot | undefined, value: unknown): void {
	if (!slot?.active || !slot.hold || slot.handed.has(value)) return;
	if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
		slot.handed.add(value);
		slot.hold(value);
	}
}

/**
 * Backends a registration outside a capture must not replace, each with what it hands such a
 * registration to instead: a process-wide backend's proxy, and its key's disposal.
 */
const guards = new WeakMap<ModelBackend, (late: unknown) => void>();

/**
 * Keep `backend`, while it is the one installed under its kind and logical name, from being replaced by
 * a registration made outside a capture (`registerBackend`, `setEmbedding`, `setGenerative`,
 * `setDecision`): a different object registered there is passed to `divert` instead of installed, and
 * the registration returns without throwing, even for an object `registerBackend` would refuse.
 * Registering `backend` itself again installs it as before. `divert` must not throw.
 */
export function guardInstalled(backend: ModelBackend, divert: (late: unknown) => void): void {
	guards.set(backend, divert);
}

/** Pass `backend` to the guard of what is installed under `kind.logicalName`, if any. Returns whether it did. */
function diverted(kind: ModelKind, logicalName: string, backend: unknown): boolean {
	if (!Object.hasOwn(registries, kind)) return false;
	const current = registries[kind].get(logicalName);
	if (current === undefined || current === backend) return false;
	const divert = guards.get(current);
	if (!divert) return false;
	divert(backend);
	return true;
}

function install(kind: ModelKind, logicalName: string, backend: ModelBackend): void {
	const slot = captureScope.getStore();
	if (slot?.active) {
		handOver(slot, backend);
		if (slot.kind !== kind || slot.logicalName !== logicalName) slot.extras.push({ kind, logicalName, backend });
		else if (!slot.exclusive || slot.backend === undefined) slot.backend = backend;
		else {
			slot.refused ??= new ModelBackendRegistrationError(
				`'${kind}.${logicalName}' is already registered by the code constructing it; a second registration under the same key is refused`
			);
			throw slot.refused;
		}
		return;
	}
	if (diverted(kind, logicalName, backend)) return;
	registries[kind].set(logicalName, backend);
}

/** Map `logicalName` to a backend for embedding calls. Re-set replaces, except a backend `guardInstalled` keeps. */
export function setEmbedding(logicalName: string, backend: ModelBackend): void {
	install('embedding', logicalName, backend);
}

/** Map `logicalName` to a backend for generative calls. Re-set replaces, except a backend `guardInstalled` keeps. */
export function setGenerative(logicalName: string, backend: ModelBackend): void {
	install('generative', logicalName, backend);
}

/** Map `logicalName` to a backend for decide calls. Re-set replaces, except a backend `guardInstalled` keeps. */
export function setDecision(logicalName: string, backend: ModelBackend): void {
	install('decision', logicalName, backend);
}

/**
 * Build a backend through its normal registration path but return it instead of installing it, so a
 * config reload can install it conditionally. A scratch logical name would be briefly visible
 * through `listBackends`, which backs the public `GET /v1/models`.
 *
 * Two options are for a caller that disposes what it captured. `hold` is given each object that
 * `register` registers, under any key, once, as it is handed over: before `registerBackend` checks it
 * and before any refusal, and even when `register` then throws, so the caller owns each one whatever
 * happens to it next, and can dispose it. With `exclusive`, a second registration under
 * `kind.logicalName` throws `ModelBackendRegistrationError` instead of replacing the first, so one
 * registration is the key's. That refusal is returned as `refused`, beside what was captured, whatever
 * `register` does with it, even rethrowing it, so the construction fails even when `register` catches it.
 */
export async function constructBackend(
	kind: ModelKind,
	logicalName: string,
	register: () => void | Promise<void>,
	options: { exclusive?: boolean; hold?: (handed: object) => void } = {}
): Promise<{ backend?: ModelBackend; extras: CapturedInstall[]; refused?: ModelBackendRegistrationError }> {
	const slot: CaptureSlot = {
		kind,
		logicalName,
		extras: [],
		active: true,
		exclusive: options.exclusive === true,
		hold: options.hold,
		handed: new Set(),
	};
	try {
		await captureScope.run(slot, async () => {
			await register();
		});
	} catch (error) {
		if (!slot.refused) throw error;
	} finally {
		slot.active = false;
	}
	return { backend: slot.backend, extras: slot.extras, refused: slot.refused };
}

/**
 * Replace `logicalName`'s backend for `kind` only if it is still `expected`. A plain `set` is atomic
 * but unconditional, so concurrent writers resolve by arrival order rather than by which value is
 * newer. A caller that loses the swap must re-derive from current state rather than overwrite.
 */
export function replaceIfCurrent(
	kind: ModelKind,
	logicalName: string,
	expected: ModelBackend | undefined,
	next: ModelBackend
): boolean {
	const map = registries[kind];
	if (map.get(logicalName) !== expected) return false;
	map.set(logicalName, next);
	return true;
}

/**
 * Remove `logicalName`'s backend for `kind` only if it is still `expected`, returning whether it was
 * removed. Withdrawing a credential must not delete a slot another writer has since taken over.
 */
export function removeIfCurrent(kind: ModelKind, logicalName: string, expected: ModelBackend | undefined): boolean {
	const map = registries[kind];
	if (map.get(logicalName) !== expected) return false;
	map.delete(logicalName);
	return true;
}

/** Non-throwing lookup of the backend mapped to `logicalName` for `kind`, or `undefined`. Used by the router to assemble + filter candidate lists without exceptions. */
export function getBackend(kind: ModelKind, logicalName: string): ModelBackend | undefined {
	return registries[kind].get(logicalName);
}

/**
 * Enumerate all registrations for `kind` as `{logicalName, backend}` pairs. Used by
 * `GET /v1/models` (#631) to advertise selectable model names; `logicalName` is what a
 * caller passes as `opts.model`, not the backend's own `.name`.
 */
export function listBackends(kind: ModelKind): Array<{ logicalName: string; backend: ModelBackend }> {
	return [...registries[kind].entries()].map(([logicalName, backend]) => ({ logicalName, backend }));
}

/**
 * Resolve the embedding backend mapped to `logicalName` (default: `'default'`).
 * Throws `ModelBackendNotFoundError` if no backend is mapped.
 */
export function resolveEmbedding(logicalName: string = 'default'): ModelBackend {
	const backend = registries.embedding.get(logicalName);
	if (!backend) throw new ModelBackendNotFoundError('embedding', logicalName);
	return backend;
}

/**
 * Resolve the generative backend mapped to `logicalName` (default: `'default'`).
 * Throws `ModelBackendNotFoundError` if no backend is mapped.
 */
export function resolveGenerative(logicalName: string = 'default'): ModelBackend {
	const backend = registries.generative.get(logicalName);
	if (!backend) throw new ModelBackendNotFoundError('generative', logicalName);
	return backend;
}

/**
 * Resolve the decision backend mapped to `logicalName` (default: `'default'`).
 * Throws `ModelBackendNotFoundError` if no backend is mapped.
 */
export function resolveDecision(logicalName: string = 'default'): ModelBackend {
	const backend = registries.decision.get(logicalName);
	if (!backend) throw new ModelBackendNotFoundError('decision', logicalName);
	return backend;
}

/**
 * Public registration API (#1325).
 *
 * The supported way for a component or app to add a backend — including
 * in-process / non-HTTP ones — under a logical id. Call it during component
 * load (e.g. `handleApplication`); the registry is process-wide, so each worker
 * thread that loads the component registers its own instance, matching how the
 * config-driven built-ins populate per process. A backend that should have one live
 * instance per key in the process (an in-process model) registers through
 * `registerProcessBackend` (`processBackend.ts`) instead, within the scope
 * resources/models/DESIGN.md states. Under a key this thread registered that way, a
 * registration outside that backend's factory is not installed over its proxy, and the
 * call does not throw: it goes, with a warning, to that backend, which tries to
 * dispose it (when: `divertLate`).
 *
 * `id` is the logical name callers select with `opts.model` (e.g.
 * `models.embed(text, { model: 'local:bge-small' })`). A provider-namespaced id
 * (`local:bge-small`, `openai:gpt-4o`) avoids collisions when multiple plugins
 * register — convention, not enforced.
 *
 * A hand-rolled backend's `capabilities()` must agree with the methods it
 * implements (the `generate` / `stream` paths gate on it); `defineBackend`
 * derives them for you, so prefer it.
 */
export function registerBackend(kind: ModelKind, id: string, backend: ModelBackend): void {
	const slot = captureScope.getStore();
	// Inside a capture with `hold`, the backend is the capturing caller's before it is checked.
	handOver(slot, backend);
	// Under a guarded key, outside a capture, it goes to the guard before it is checked, so this never throws.
	if (!slot?.active && diverted(kind, id, backend)) return;
	assertBackendForKind(kind, id, backend);
	if (kind === 'embedding') setEmbedding(id, backend);
	else if (kind === 'decision') setDecision(id, backend);
	else setGenerative(id, backend);
}

/** Throw `ModelBackendRegistrationError` unless `kind` and `id` are valid and `backend` can serve `kind`. */
export function assertBackendForKind(kind: ModelKind, id: string, backend: ModelBackend): void {
	assertKindAndId(kind, id);
	if (
		!backend ||
		typeof backend.capabilities !== 'function' ||
		typeof backend.name !== 'string' ||
		backend.name.length === 0
	)
		throw new ModelBackendRegistrationError(`backend '${id}' must be a ModelBackend with a name and capabilities()`);
	if (kind === 'embedding') {
		if (typeof backend.embed !== 'function')
			throw new ModelBackendRegistrationError(`embedding backend '${id}' must implement embed()`);
	} else if (kind === 'decision') {
		if (typeof backend.decide !== 'function')
			throw new ModelBackendRegistrationError(`decision backend '${id}' must implement decide()`);
	} else if (typeof backend.generate !== 'function' && typeof backend.generateStream !== 'function') {
		throw new ModelBackendRegistrationError(`generative backend '${id}' must implement generate() or generateStream()`);
	}
}

/** Throw `ModelBackendRegistrationError` unless `kind` is a registry kind and `id` a non-empty string. */
export function assertKindAndId(kind: ModelKind, id: string): void {
	if (kind !== 'embedding' && kind !== 'generative' && kind !== 'decision')
		throw new ModelBackendRegistrationError(
			`kind must be 'embedding', 'generative' or 'decision', got '${String(kind)}'`
		);
	if (typeof id !== 'string' || id.length === 0)
		throw new ModelBackendRegistrationError('backend id must be a non-empty string');
}

/**
 * Build a `ModelBackend` from just the methods it implements. `capabilities()`
 * is derived from which of `embed` / `generate` / `generateStream` / `decide` /
 * `scoreChoices` are present;
 * `tools` and `adapters` aren't inferable from method presence, so pass them
 * explicitly (both default `false`). Lowers the bar from authoring a class to
 * supplying a function — pair with `registerBackend`. See #1325.
 */
export function defineBackend(spec: DefineBackendSpec): ModelBackend {
	if (!spec || typeof spec.name !== 'string' || spec.name.length === 0)
		throw new ModelBackendRegistrationError('defineBackend requires a non-empty name');
	const {
		name,
		embed,
		generate,
		generateStream,
		decide,
		scoreChoices,
		tools = false,
		adapters = false,
		calibrated = false,
		structuredOutput = false,
		noMatch = false,
		calibratedNoMatch = false,
		maxScoredChoices,
	} = spec;
	// Gate on function-ness, not truthiness: a non-function value (`generate: 'oops'`)
	// must be rejected at definition time, not assigned and crash at call time.
	const hasEmbed = typeof embed === 'function';
	const hasGenerate = typeof generate === 'function';
	const hasStream = typeof generateStream === 'function';
	const hasDecide = typeof decide === 'function';
	const hasScore = typeof scoreChoices === 'function';
	if (!hasEmbed && !hasGenerate && !hasStream && !hasDecide && !hasScore)
		throw new ModelBackendRegistrationError(
			`backend '${name}' must implement at least one of embed / generate / generateStream / decide / scoreChoices (as functions)`
		);
	if (maxScoredChoices !== undefined && !(Number.isSafeInteger(maxScoredChoices) && maxScoredChoices > 0))
		throw new ModelBackendRegistrationError(`backend '${name}': maxScoredChoices must be a positive integer`);
	const capabilities: ModelCapabilities = Object.freeze({
		embed: hasEmbed,
		// A stream-only backend gains generate() via the synthesis below.
		generate: hasGenerate || hasStream,
		stream: hasStream,
		tools,
		adapters,
		decide: hasDecide,
		calibrated: hasDecide && calibrated,
		scoreChoices: hasScore,
		structuredOutput: (hasGenerate || hasStream) && structuredOutput,
		noMatch: hasDecide && noMatch,
		calibratedNoMatch: hasDecide && noMatch && calibratedNoMatch,
		...(hasScore && maxScoredChoices !== undefined ? { maxScoredChoices } : {}),
	});
	const backend: ModelBackend = { name, capabilities: () => capabilities };
	if (hasEmbed) backend.embed = embed;
	if (hasGenerate) backend.generate = generate;
	if (hasStream) backend.generateStream = generateStream;
	if (hasDecide) backend.decide = decide;
	if (hasScore) backend.scoreChoices = scoreChoices;
	// Stream-only generative backend: synthesize generate() by draining the stream,
	// so a plain models.generate() works without the backend implementing both.
	if (hasStream && !hasGenerate) backend.generate = synthesizeGenerateFromStream(generateStream!);
	return backend;
}

/**
 * Build a `generate` from a backend's `generateStream` by draining it into a
 * single `GenerateResult`. Accumulates text and the terminal finish reason;
 * tool calls are forwarded best-effort (only those that arrive complete in a
 * single chunk — the chunk type carries no call index to reassemble fragments,
 * so a backend that streams partial tool calls should implement `generate()`).
 */
function synthesizeGenerateFromStream(
	generateStream: NonNullable<ModelBackend['generateStream']>
): NonNullable<ModelBackend['generate']> {
	return async (input, opts) => {
		let content = '';
		let finishReason: GenerateResult['finishReason'] = 'stop';
		const toolCalls: ToolCall[] = [];
		for await (const chunk of generateStream(input, opts)) {
			if (chunk.deltaContent) content += chunk.deltaContent;
			if (chunk.finishReason) finishReason = chunk.finishReason;
			for (const tc of chunk.deltaToolCalls ?? []) {
				if (typeof tc.id === 'string' && typeof tc.name === 'string') toolCalls.push(tc as ToolCall);
			}
		}
		const output: GenerateResult =
			toolCalls.length > 0 ? { content, finishReason, toolCalls } : { content, finishReason };
		return { status: 'completed', output };
	};
}

/** Remove all registrations. Test-only hygiene. */
export function clearRegistry(): void {
	for (const map of Object.values(registries)) map.clear();
}

export class ModelBackendNotFoundError extends ServerError {
	// Message identifies the kind + logical name only; never enumerates other
	// registered names to avoid leaking the registry shape in error responses.
	constructor(kind: ModelKind, logicalName: string) {
		super(`No backend registered for '${kind}.${logicalName}'`);
		this.name = 'ModelBackendNotFoundError';
	}
}

/** Thrown by `registerBackend` / `defineBackend` on invalid registration input. */
export class ModelBackendRegistrationError extends ServerError {
	constructor(message: string) {
		super(message);
		this.name = 'ModelBackendRegistrationError';
	}
}
