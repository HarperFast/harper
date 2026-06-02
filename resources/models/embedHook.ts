/**
 * `@embed` directive write-time hook. `createDefaultEmbedder` builds the embedder
 * a table registers for an `@embed` attribute; `buildEmbedBefore` produces the
 * pre-commit callback that runs registered embedders and writes their vectors onto
 * the record before it commits.
 */

// Lazily resolved to avoid a require cycle on the unit-test load path; only needed on failure.
function getLogger(): { error?: (...args: any[]) => void } {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require('#src/utility/logging/logger').logger ?? {};
	} catch {
		return {};
	}
}

export type EmbedConfig = {
	source: string;
	model: string;
};

export type EmbedAttribute = {
	name: string;
	embed: EmbedConfig;
};

export type Embedder = (record: any) => Promise<number[] | Float32Array | null | undefined>;

// Matches the public `Models.embed` signature; a named type so tests can inject a fake.
type EmbedFn = (
	input: string | string[],
	opts: { model?: string; inputType?: 'document' | 'query' }
) => Promise<Float32Array[]>;

// Lazy-imported so this module can be unit-tested without loading the transaction
// stack `Models.ts` pulls in. Overridable via `__setEmbedFnForTest`.
let _embedFn: EmbedFn | undefined;
function resolveEmbedFn(): EmbedFn {
	if (_embedFn) return _embedFn;
	const { Models } = require('#src/resources/models/Models'); // eslint-disable-line @typescript-eslint/no-var-requires
	const models = new Models();
	_embedFn = (input, opts) => models.embed(input, opts);
	return _embedFn;
}

/** Test seam: override the embed function. Pass `undefined` to reset to `Models.embed`. */
export function __setEmbedFnForTest(fn: EmbedFn | undefined): void {
	_embedFn = fn;
}

export function createDefaultEmbedder(embedConfig: EmbedConfig): Embedder {
	const { source, model } = embedConfig;
	return async (record: any): Promise<number[] | null | undefined> => {
		const sourceValue = record?.[source];
		if (sourceValue == null) return null;
		const vectors = await resolveEmbedFn()(String(sourceValue), {
			model,
			inputType: 'document',
		});
		const v = vectors?.[0];
		if (v == null) return undefined;
		// Store as a plain array — typed arrays don't round-trip through the record encoder.
		return v instanceof Float32Array ? Array.from(v) : Array.from(v as any);
	};
}

/**
 * Build the pre-commit callback that runs embedders for every `@embed` attribute whose
 * source field is present in this write. Returns `undefined` when there's nothing to do
 * (no `@embed` attributes, a replication-receiver write, or no source field in the payload),
 * so the call site can skip it.
 *
 * Source-field semantics: embed only when the source field is in the payload. A PATCH that
 * omits it leaves the existing vector untouched; an explicit `source: null` clears the vector.
 */
export function buildEmbedBefore(
	record: any,
	context: any,
	options: any,
	embedAttributes: EmbedAttribute[] | undefined,
	userEmbedders: Record<string, Embedder>
): (() => Promise<void>) | undefined {
	if (!embedAttributes || embedAttributes.length === 0) return undefined;
	// Skip when the write already carries the vector: cluster-replication receiver
	// (isNotification), REST x-replicate-from:none, or audit-log replay. Note that
	// proactive source-subscribe pushes also set isNotification and so skip embedding.
	if (options?.isNotification === true || context?.replicateFrom === false || context?.alreadyLogged === true) {
		return undefined;
	}
	if (!record || typeof record !== 'object') return undefined;
	let anySourcePresent = false;
	for (const attr of embedAttributes) {
		const sourceKey = attr.embed?.source;
		if (sourceKey && sourceKey in record) {
			anySourcePresent = true;
			break;
		}
	}
	if (!anySourcePresent) return undefined;
	return async (): Promise<void> => {
		// Parallel: each embedder mutates a distinct attribute, so there's no ordering hazard.
		await Promise.all(
			embedAttributes.map(async (attr) => {
				const sourceKey = attr.embed?.source;
				if (!sourceKey) return;
				if (!(sourceKey in record)) return;
				const sourceValue = record[sourceKey];
				if (sourceValue == null) {
					record[attr.name] = null;
					return;
				}
				// CRDT op payloads (`{__op__, value}`) aren't a meaningful embed source; skip.
				if (sourceValue && typeof sourceValue === 'object' && (sourceValue as any).__op__) return;
				const embedder = userEmbedders[attr.name];
				if (!embedder) return;
				let vector;
				try {
					vector = await embedder(record);
				} catch (err) {
					// Backend errors can carry URLs / key tails; log raw, rethrow sanitized.
					getLogger().error?.(`Embedder for attribute "${attr.name}" failed:`, err);
					throw new Error(`Failed to compute embedding for attribute "${attr.name}"`);
				}
				record[attr.name] = normalizeVector(vector);
			})
		);
	};
}

// Custom embedders may return any typed array; flatten to a plain array so it round-trips
// through the record encoder. NaN is left for HNSW to reject at index time.
function normalizeVector(vector: any): number[] | null {
	if (vector == null) return null;
	if (Array.isArray(vector)) return vector;
	if (ArrayBuffer.isView(vector)) return Array.from(vector as any);
	return vector;
}
