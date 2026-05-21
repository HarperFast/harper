import { ServerError } from '../../utility/errors/hdbError.ts';
import type { ModelBackend } from './types.ts';

/**
 * Process-wide model backend registry.
 *
 * Stores logical-name → backend-instance mappings for embedding and
 * generative kinds. Boot wiring populates the registry via
 * `setEmbedding(...)` / `setGenerative(...)`; the `Models` facade reads it
 * via `resolveEmbedding(...)` / `resolveGenerative(...)`.
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
