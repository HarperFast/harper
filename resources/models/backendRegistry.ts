import { ServerError } from '../../utility/errors/hdbError.ts';
import type { DefineBackendSpec, ModelBackend, ModelCapabilities } from './types.ts';

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

/** Map `logicalName` to a backend for embedding calls. Re-set replaces. */
export function setEmbedding(logicalName: string, backend: ModelBackend): void {
	embedding.set(logicalName, backend);
}

/** Map `logicalName` to a backend for generative calls. Re-set replaces. */
export function setGenerative(logicalName: string, backend: ModelBackend): void {
	generative.set(logicalName, backend);
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
	if (!embed && !generate && !generateStream)
		throw new ModelBackendRegistrationError(
			`backend '${name}' must implement at least one of embed / generate / generateStream`
		);
	const capabilities: ModelCapabilities = Object.freeze({
		embed: typeof embed === 'function',
		generate: typeof generate === 'function',
		stream: typeof generateStream === 'function',
		tools,
		adapters,
	});
	const backend: ModelBackend = { name, capabilities: () => capabilities };
	if (embed) backend.embed = embed;
	if (generate) backend.generate = generate;
	if (generateStream) backend.generateStream = generateStream;
	return backend;
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
