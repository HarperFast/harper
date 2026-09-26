/**
 * `@embed` directive write-time hook. `createDefaultEmbedder` builds the embedder
 * a table registers for an `@embed` attribute; `buildEmbedBefore` produces the
 * pre-commit callback that runs registered embedders and writes their vectors onto
 * the record before it commits. The trigger rules, source handling, error sanitizing
 * and hook composition are shared with the `@decide` hook (`decideHook.ts`).
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

/**
 * Whether a write-time model hook runs for this write at all. Skip when the write already
 * carries the derived attributes: a cluster-replication receiver (isNotification), REST
 * x-replicate-from:none, or audit-log replay. Proactive source-subscribe pushes also set
 * isNotification and so skip. One predicate for `@embed` and `@decide` so their trigger rules
 * cannot drift.
 */
export function writeHookApplies(record: any, context: any, options: any): boolean {
	if (options?.isNotification === true || context?.replicateFrom === false || context?.alreadyLogged === true)
		return false;
	return Boolean(record) && typeof record === 'object';
}

/**
 * How a hook treats one source field of the write payload: absent leaves the derived
 * attributes alone (a PATCH that omits the source), null clears them, a CRDT op payload
 * (`{__op__, value}`) is not a meaningful input and is skipped, and a value is derived from.
 */
export type SourceState = 'absent' | 'null' | 'op' | 'value';
export function sourceState(record: any, sourceKey: string | undefined): SourceState {
	if (!sourceKey || !(sourceKey in record)) return 'absent';
	const value = record[sourceKey];
	if (value == null) return 'null';
	if (typeof value === 'object' && (value as any).__op__) return 'op';
	return 'value';
}

/** Settle every job before reporting the first failure, so no job keeps mutating the record after the write is rejected. */
export async function settleAll(jobs: Promise<void>[]): Promise<void> {
	for (const result of await Promise.allSettled(jobs)) if (result.status === 'rejected') throw result.reason;
}

/** The pre-commit callbacks of the write hooks as one; they write disjoint attributes, so they run concurrently. */
export function combineWriteHooks(
	...hooks: Array<(() => Promise<void>) | undefined>
): (() => Promise<void>) | undefined {
	const present = hooks.filter((hook): hook is () => Promise<void> => hook !== undefined);
	if (present.length === 0) return undefined;
	if (present.length === 1) return present[0];
	return () => settleAll(present.map((hook) => hook()));
}

const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Backend errors can carry URLs / key tails; log raw, return a sanitized error to throw. Only
 * safe identifiers are included (an identifier-shaped error class name, a finite upstream HTTP
 * status) so the failure is diagnosable without hunting through server logs (#1593).
 * `upstreamStatus` is the provider's status — NOT ServerError's statusCode, which is Harper's
 * own response status and would misleadingly read 500 here.
 */
export function sanitizedHookError(actor: string, product: string, attributeName: string, err: unknown): Error {
	getLogger().error?.(`${actor} for attribute "${attributeName}" failed:`, err);
	const status = (err as any)?.upstreamStatus;
	const errName = (err as any)?.name;
	const detail =
		(typeof errName === 'string' && errName !== 'Error' && SAFE_ERROR_NAME.test(errName) ? ` [${errName}]` : '') +
		(Number.isInteger(status) && status >= 100 && status <= 599 ? ` (backend HTTP ${status})` : '');
	return new Error(
		`Failed to compute ${product} for attribute "${attributeName}"${detail} — see server log for details`
	);
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
	if (!writeHookApplies(record, context, options)) return undefined;
	if (!embedAttributes.some((attr) => sourceState(record, attr.embed?.source) !== 'absent')) return undefined;
	// Parallel: each embedder mutates a distinct attribute, so there's no ordering hazard.
	return () =>
		settleAll(
			embedAttributes.map(async (attr) => {
				const state = sourceState(record, attr.embed?.source);
				if (state === 'absent' || state === 'op') return;
				if (state === 'null') {
					record[attr.name] = null;
					return;
				}
				const embedder = userEmbedders[attr.name];
				if (!embedder) return;
				let vector;
				try {
					vector = await embedder(record);
				} catch (err) {
					throw sanitizedHookError('Embedder', 'embedding', attr.name, err);
				}
				record[attr.name] = normalizeVector(vector);
			})
		);
}

// Custom embedders may return any typed array; flatten to a plain array so it round-trips
// through the record encoder. NaN is left for HNSW to reject at index time.
function normalizeVector(vector: any): number[] | null {
	if (vector == null) return null;
	if (Array.isArray(vector)) return vector;
	if (ArrayBuffer.isView(vector)) return Array.from(vector as any);
	return vector;
}
