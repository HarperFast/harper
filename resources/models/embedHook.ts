import { ClientError } from '../../utility/errors/hdbError.ts';
import { validateDecisionSchema } from './decision.ts';

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

/** The signal aborts when a sibling hook of the same write fails; a hook that honors it lets the write fail promptly. */
export type WriteHookContext = { signal: AbortSignal };

export type Embedder = (record: any, hook?: WriteHookContext) => Promise<number[] | Float32Array | null | undefined>;

/** A pre-commit callback of one write; `signal` is the write's, aborted when another hook of the write fails. */
export type WriteHook = (signal?: AbortSignal) => Promise<void>;

type EmbedFn = (
	input: string | string[],
	opts: { model?: string; inputType?: 'document' | 'query'; signal?: AbortSignal }
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

/**
 * Run the jobs of one write. The first failure aborts the others, and every job settles before
 * that failure is reported: a rejected write neither waits on a sibling that honors the signal
 * nor keeps being mutated by one that has not finished. A job that ignores the signal is
 * awaited regardless, so the model calls behind the built-in hooks forward it.
 */
export async function runWriteJobs(
	jobs: Array<(signal: AbortSignal) => Promise<void>>,
	signal?: AbortSignal
): Promise<void> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener('abort', onAbort, { once: true });
	let failed = false;
	let failure: unknown;
	try {
		await Promise.all(
			jobs.map((job) =>
				job(controller.signal).catch((err) => {
					if (!failed) {
						failed = true;
						failure = err;
					}
					controller.abort(err);
				})
			)
		);
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
	if (failed) throw failure;
}

export function combineWriteHooks(a: WriteHook | undefined, b: WriteHook | undefined): WriteHook | undefined {
	if (!a) return b;
	if (!b) return a;
	return (signal) => runWriteJobs([a, b], signal);
}

const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Backend errors can carry URLs / key tails; log raw, return a sanitized error to throw. Only
 * safe identifiers are included (an identifier-shaped error class name, a finite upstream HTTP
 * status) so the failure is diagnosable without hunting through server logs (#1593).
 * `upstreamStatus` is the provider's status — NOT ServerError's statusCode, which is Harper's
 * own response status and would misleadingly read 500 here.
 */
export function sanitizedHookError(
	actor: string,
	product: string,
	attributeName: string,
	err: unknown,
	log = true
): Error {
	if (log) getLogger().error?.(`${actor} for attribute "${attributeName}" failed:`, err);
	const status = (err as any)?.upstreamStatus;
	const errName = (err as any)?.name;
	const detail =
		(typeof errName === 'string' && errName !== 'Error' && SAFE_ERROR_NAME.test(errName) ? ` [${errName}]` : '') +
		(Number.isInteger(status) && status >= 100 && status <= 599 ? ` (backend HTTP ${status})` : '');
	return new Error(
		`Failed to compute ${product} for attribute "${attributeName}"${detail} — see server log for details`
	);
}

type DerivedAttribute = {
	name: string;
	type?: string;
	nullable?: boolean;
	isPrimaryKey?: boolean;
	computed?: unknown;
	embed?: { source: string };
	decide?: { source: string; confidence?: string; schema?: unknown };
};

const LEAF_KIND_BY_TYPE: Record<string, (schema: any) => boolean> = {
	String: (schema) => Array.isArray(schema?.enum),
	Boolean: (schema) => schema?.type === 'boolean',
	Int: (schema) => schema?.type === 'integer',
};

/**
 * Every derived field (an `@embed` target, a `@decide` target or confidence) has exactly one
 * writer, and no directive derives from another directive's output: the hooks run concurrently
 * within one write, so the stored pair would otherwise depend on scheduling. A source and a
 * confidence field must be declared; a decided field and its confidence field are nullable,
 * neither the primary key nor computed, the decided field's type matches its leaf and the leaf
 * is a valid decision schema; and none of those fields may be named after an `Object.prototype`
 * key, because `sourceState` tests presence with `in`. Run on the complete attribute list.
 */
export function assertDerivedFieldOwnership(attributes: DerivedAttribute[]): void {
	const declared = new Map<string, DerivedAttribute>();
	for (const attribute of attributes) declared.set(attribute.name, attribute);
	const writers = new Map<string, string>();
	const claim = (field: string, writer: string) => {
		const prior = writers.get(field);
		if (prior) throw new ClientError(`${writer} and ${prior} both write "${field}"`, 400);
		writers.set(field, writer);
	};
	const directives = (
		attribute: DerivedAttribute
	): Array<[string, { source: string; confidence?: string; schema?: unknown }]> => {
		const out: Array<[string, { source: string; confidence?: string; schema?: unknown }]> = [];
		if (attribute.embed) out.push(['@embed', attribute.embed]);
		if (attribute.decide) out.push(['@decide', attribute.decide]);
		return out;
	};
	for (const attribute of attributes) {
		for (const [directive, config] of directives(attribute)) {
			const writer = `${directive} on "${attribute.name}"`;
			for (const field of [attribute.name, config.source, config.confidence])
				if (field && Object.hasOwn(Object.prototype, field))
					throw new ClientError(
						`${writer}: "${field}" is an Object.prototype key and cannot be a derived, source or confidence field`,
						400
					);
			if (!declared.has(config.source))
				throw new ClientError(`${writer} references unknown source field "${config.source}"`, 400);
			if (directive === '@decide') {
				if (attribute.isPrimaryKey || attribute.computed)
					throw new ClientError(`${writer} cannot combine with @primaryKey or @computed`, 400);
				if (attribute.nullable === false)
					throw new ClientError(`${writer} cannot be declared non-null: a null source clears the attribute`, 400);
				try {
					validateDecisionSchema(config.schema);
				} catch (err) {
					throw new ClientError(`${writer}: ${(err as Error).message}`, 400);
				}
				if (attribute.type !== undefined) {
					const matches = LEAF_KIND_BY_TYPE[attribute.type];
					if (!matches)
						throw new ClientError(
							`${writer} requires a String, Boolean or Int attribute type; got "${attribute.type === 'array' ? '[...]' : attribute.type}"`,
							400
						);
					if (!matches(config.schema))
						throw new ClientError(`${writer}: the decision schema does not fit a ${attribute.type} attribute`, 400);
				}
			}
			claim(attribute.name, writer);
			if (config.confidence) {
				const confidence = declared.get(config.confidence);
				if (!confidence)
					throw new ClientError(`${writer} references unknown confidence field "${config.confidence}"`, 400);
				if (confidence.type !== undefined && confidence.type !== 'Float')
					throw new ClientError(
						`${writer} requires a Float confidence attribute; "${config.confidence}" is ${confidence.type === 'array' ? '[...]' : confidence.type}`,
						400
					);
				if (confidence.nullable === false)
					throw new ClientError(
						`${writer}: confidence attribute "${config.confidence}" cannot be declared non-null: a null source clears it`,
						400
					);
				if (confidence.isPrimaryKey || confidence.computed)
					throw new ClientError(
						`${writer}: confidence attribute "${config.confidence}" cannot be @primaryKey or @computed`,
						400
					);
				claim(config.confidence, writer);
			}
		}
	}
	for (const attribute of attributes) {
		for (const [directive, config] of directives(attribute)) {
			const sourceWriter = writers.get(config.source);
			if (sourceWriter)
				throw new ClientError(
					`${directive} on "${attribute.name}" derives from "${config.source}", which ${sourceWriter} writes`,
					400
				);
		}
	}
}

export function createDefaultEmbedder(embedConfig: EmbedConfig): Embedder {
	const { source, model } = embedConfig;
	return async (record: any, hook?: WriteHookContext): Promise<number[] | null | undefined> => {
		const sourceValue = record?.[source];
		if (sourceValue == null) return null;
		const vectors = await resolveEmbedFn()(String(sourceValue), {
			model,
			inputType: 'document',
			signal: hook?.signal,
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
): WriteHook | undefined {
	if (!embedAttributes || embedAttributes.length === 0) return undefined;
	if (!writeHookApplies(record, context, options)) return undefined;
	let present = false;
	for (const attr of embedAttributes) if (sourceState(record, attr.embed?.source) !== 'absent') present = true;
	if (!present) return undefined;
	return (signal) =>
		runWriteJobs(
			embedAttributes.map((attr) => async (jobSignal) => {
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
					vector = await embedder(record, { signal: jobSignal });
				} catch (err) {
					// An aborted job failed because a sibling did; only that failure is worth a log line.
					throw sanitizedHookError('Embedder', 'embedding', attr.name, err, !jobSignal.aborted);
				}
				record[attr.name] = normalizeVector(vector);
			}),
			signal
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
