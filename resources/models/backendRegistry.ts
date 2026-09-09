import { AsyncLocalStorage } from 'node:async_hooks';
import { ServerError } from '../../utility/errors/hdbError.ts';
import type { DefineBackendSpec, GenerateResult, ModelBackend, ModelCapabilities, ToolCall } from './types.ts';

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

type ModelKind = 'embedding' | 'generative';

const embedding: Map<string, ModelBackend> = new Map();
const generative: Map<string, ModelBackend> = new Map();

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
	 * ends the scope deactivates so a late same-slot registration installs normally. */
	active: boolean;
}

// Async-context scoped: a module-global slot would divert unrelated registrations and collide
// concurrent constructions.
const captureScope = new AsyncLocalStorage<CaptureSlot>();

function install(kind: ModelKind, logicalName: string, backend: ModelBackend): void {
	const slot = captureScope.getStore();
	if (slot?.active) {
		if (slot.kind === kind && slot.logicalName === logicalName) slot.backend = backend;
		else slot.extras.push({ kind, logicalName, backend });
		return;
	}
	(kind === 'embedding' ? embedding : generative).set(logicalName, backend);
}

/** Map `logicalName` to a backend for embedding calls. Re-set replaces. */
export function setEmbedding(logicalName: string, backend: ModelBackend): void {
	install('embedding', logicalName, backend);
}

/** Map `logicalName` to a backend for generative calls. Re-set replaces. */
export function setGenerative(logicalName: string, backend: ModelBackend): void {
	install('generative', logicalName, backend);
}

/**
 * Build a backend through its normal registration path but return it instead of installing it, so a
 * config reload can install it conditionally. A scratch logical name would be briefly visible
 * through `listBackends`, which backs the public `GET /v1/models`.
 */
export async function constructBackend(
	kind: ModelKind,
	logicalName: string,
	register: () => void | Promise<void>
): Promise<{ backend?: ModelBackend; extras: CapturedInstall[] }> {
	const slot: CaptureSlot = { kind, logicalName, extras: [], active: true };
	try {
		await captureScope.run(slot, async () => {
			await register();
		});
	} finally {
		slot.active = false;
	}
	return { backend: slot.backend, extras: slot.extras };
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
	const map = kind === 'embedding' ? embedding : generative;
	if (map.get(logicalName) !== expected) return false;
	map.set(logicalName, next);
	return true;
}

/**
 * Remove `logicalName`'s backend for `kind` only if it is still `expected`, returning whether it was
 * removed. Withdrawing a credential must not delete a slot another writer has since taken over.
 */
export function removeIfCurrent(kind: ModelKind, logicalName: string, expected: ModelBackend | undefined): boolean {
	const map = kind === 'embedding' ? embedding : generative;
	if (map.get(logicalName) !== expected) return false;
	map.delete(logicalName);
	return true;
}

/** Non-throwing lookup of the backend mapped to `logicalName` for `kind`, or `undefined`. Used by the router to assemble + filter candidate lists without exceptions. */
export function getBackend(kind: ModelKind, logicalName: string): ModelBackend | undefined {
	return (kind === 'embedding' ? embedding : generative).get(logicalName);
}

/**
 * Enumerate all registrations for `kind` as `{logicalName, backend}` pairs. Used by
 * `GET /v1/models` (#631) to advertise selectable model names; `logicalName` is what a
 * caller passes as `opts.model`, not the backend's own `.name`.
 */
export function listBackends(kind: ModelKind): Array<{ logicalName: string; backend: ModelBackend }> {
	const map = kind === 'embedding' ? embedding : generative;
	return [...map.entries()].map(([logicalName, backend]) => ({ logicalName, backend }));
}

/**
 * Resolve the embedding backend mapped to `logicalName` (default: `'default'`).
 * Throws `ModelBackendNotFoundError` if no backend is mapped.
 */
export function resolveEmbedding(logicalName: string = 'default'): ModelBackend {
	const backend = embedding.get(logicalName);
	if (!backend) throw new ModelBackendNotFoundError('embedding', logicalName);
	return backend;
}

/**
 * Resolve the generative backend mapped to `logicalName` (default: `'default'`).
 * Throws `ModelBackendNotFoundError` if no backend is mapped.
 */
export function resolveGenerative(logicalName: string = 'default'): ModelBackend {
	const backend = generative.get(logicalName);
	if (!backend) throw new ModelBackendNotFoundError('generative', logicalName);
	return backend;
}

/**
 * Public registration API (#1325).
 *
 * The supported way for a component or app to add a backend — including
 * in-process / non-HTTP ones — under a logical id. Call it during component
 * load (e.g. `handleApplication`); the registry is process-wide, so each worker
 * thread that loads the component registers its own instance, matching how the
 * config-driven built-ins populate per process.
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
	if (kind !== 'embedding' && kind !== 'generative')
		throw new ModelBackendRegistrationError(`kind must be 'embedding' or 'generative', got '${String(kind)}'`);
	if (typeof id !== 'string' || id.length === 0)
		throw new ModelBackendRegistrationError('backend id must be a non-empty string');
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
		setEmbedding(id, backend);
	} else {
		if (typeof backend.generate !== 'function' && typeof backend.generateStream !== 'function')
			throw new ModelBackendRegistrationError(
				`generative backend '${id}' must implement generate() or generateStream()`
			);
		setGenerative(id, backend);
	}
}

/**
 * Build a `ModelBackend` from just the methods it implements. `capabilities()`
 * is derived from which of `embed` / `generate` / `generateStream` are present;
 * `tools` and `adapters` aren't inferable from method presence, so pass them
 * explicitly (both default `false`). Lowers the bar from authoring a class to
 * supplying a function — pair with `registerBackend`. See #1325.
 */
export function defineBackend(spec: DefineBackendSpec): ModelBackend {
	if (!spec || typeof spec.name !== 'string' || spec.name.length === 0)
		throw new ModelBackendRegistrationError('defineBackend requires a non-empty name');
	const { name, embed, generate, generateStream, tools = false, adapters = false } = spec;
	// Gate on function-ness, not truthiness: a non-function value (`generate: 'oops'`)
	// must be rejected at definition time, not assigned and crash at call time.
	const hasEmbed = typeof embed === 'function';
	const hasGenerate = typeof generate === 'function';
	const hasStream = typeof generateStream === 'function';
	if (!hasEmbed && !hasGenerate && !hasStream)
		throw new ModelBackendRegistrationError(
			`backend '${name}' must implement at least one of embed / generate / generateStream (as functions)`
		);
	const capabilities: ModelCapabilities = Object.freeze({
		embed: hasEmbed,
		// A stream-only backend gains generate() via the synthesis below.
		generate: hasGenerate || hasStream,
		stream: hasStream,
		tools,
		adapters,
	});
	const backend: ModelBackend = { name, capabilities: () => capabilities };
	if (hasEmbed) backend.embed = embed;
	if (hasGenerate) backend.generate = generate;
	if (hasStream) backend.generateStream = generateStream;
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
	embedding.clear();
	generative.clear();
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
