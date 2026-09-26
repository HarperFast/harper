import { _assignPackageExport } from '../../globals.js';
import { contextStorage } from '../transaction.ts';
import {
	defineBackend,
	getBackend,
	ModelBackendNotFoundError,
	registerBackend as registerBackendImpl,
} from './backendRegistry.ts';
import { getRouter, registerRouter as registerRouterImpl } from './routing.ts';
import { getModelCallAnalyticsWriter, type ModelCallAnalyticsWriter, type ModelCallRecord } from './analyticsTable.ts';
import { recordAction } from '../analytics/write.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';
import { runAgentLoop, runAgentLoopStream } from './agentLoop.ts';
import { DecisionContractError, normalizeDecision, stateToText, validateDecisionSchema } from './decision.ts';
import { assignFiniteTokenCount } from './backendHelpers.ts';
import type {
	AccountingContext,
	BackendOpts,
	Capability,
	ChoiceScores,
	DecideInput,
	DecideOpts,
	Decision,
	DecisionSchema,
	DefineBackendSpec,
	EmbedOpts,
	GenerateChunk,
	GenerateInput,
	GenerateOpts,
	GenerateResult,
	ModelBackend,
	ModelKind,
	ModelRouter,
	ModelCallResult,
	Models as ModelsContract,
	ScoreChoicesOpts,
	TokenUsage,
} from './types.ts';

type CallMethod = ModelCallRecord['method'];
type MetricEmitter = (value: number, metric: string, path?: string) => void;

/**
 * Process-wide singleton. One shared instance serves all Scopes — `scope.models`,
 * `global.models`, and `import { models } from 'harperdb'` all alias the same object.
 *
 * On every call:
 * - Resolves the configured backend via `backendRegistry`.
 * - Reads the ALS-bound request `Context` to extract accounting context
 *   (tenantId, handlerPath) and an `AbortSignal`. Outside an ALS scope
 *   (app-init, internal jobs), accounting is empty and signal is undefined.
 * - Records the call to `hdb_model_calls` via the buffered writer — both
 *   successful and failed calls land in the table for billing visibility.
 *   Pre-call resolution / capability errors land too, with `backend: 'unknown'`.
 *
 * The ALS pattern matches `resources/Table.ts:3517` and is rooted at
 * `resources/transaction.ts:6`.
 */
export class Models implements ModelsContract {
	#analyticsWriter: ModelCallAnalyticsWriter;
	#emit: MetricEmitter;

	constructor(
		analyticsWriter: ModelCallAnalyticsWriter = getModelCallAnalyticsWriter(),
		// DI'd for unit tests; production wires up the module-scope `recordAction`.
		metricEmitter: MetricEmitter = recordAction
	) {
		this.#analyticsWriter = analyticsWriter;
		this.#emit = metricEmitter;
	}

	/**
	 * Register a custom backend under a logical id (e.g. `'local:bge-small'`),
	 * then select it per call with `opts.model`. The public path for components
	 * and apps to add in-process or third-party backends; pair with
	 * `models.defineBackend` to build the backend from a few methods. Namespaced
	 * under `models` (`scope.models.registerBackend(...)`), not a generic global. See #1325.
	 */
	registerBackend(kind: ModelKind, id: string, backend: ModelBackend): void {
		registerBackendImpl(kind, id, backend);
	}

	/**
	 * Build a `ModelBackend` from a small spec — supply only the methods your
	 * backend implements and `capabilities()` is derived. Pair with
	 * `models.registerBackend`. Namespaced under `models`
	 * (`scope.models.defineBackend(...)`), not a generic global. See #1325.
	 */
	defineBackend(spec: DefineBackendSpec): ModelBackend {
		return defineBackend(spec);
	}

	/**
	 * Replace the model selection policy with a custom router (#1326). Reachable as
	 * `scope.models.registerRouter(...)` / `models.registerRouter(...)`; namespaced under
	 * `models` rather than a generic global. See the `ModelRouter` type.
	 */
	registerRouter(router: ModelRouter): void {
		registerRouterImpl(router);
	}

	async embed(input: string | string[], opts: EmbedOpts = {}): Promise<Float32Array[]> {
		return (await this.embedWithUsage(input, opts)).vectors;
	}

	/**
	 * `embed()` plus the result-level `usage` the winning backend reported (all
	 * built-in embedding backends provide it). Internal path for callers that must
	 * surface usage on the wire — the `/v1/embeddings` gateway — without changing
	 * the public `embed()` contract. Not part of the stable models API.
	 */
	async embedWithUsage(
		input: string | string[],
		opts: EmbedOpts = {}
	): Promise<{ vectors: Float32Array[]; usage?: TokenUsage }> {
		const { accounting, signal } = resolveCallContext(opts.signal);
		const startedAt = performance.now();
		const resolved = resolveCandidates('embedding', opts.model, buildRequires('embed', opts.requires, false));
		if ('error' in resolved) {
			this.#recordFailure(resolved.backend, 'embed', opts.model, accounting, undefined, startedAt, resolved.error);
			throw resolved.error;
		}
		// Try candidates in order, recording each attempt. Fall through to the next on
		// ANY backend error — candidates are heterogeneous, so a limit/input error on
		// one may still succeed on another; treating an error as "not worth a fallback"
		// is a router/caller policy, not a facade default (#1537). If every candidate
		// fails, surface the FIRST (primary) error: the caller asked for that backend,
		// so it is the most diagnostic. A caller abort short-circuits.
		let firstError: unknown = undefined;
		let hasError = false;
		for (const backend of resolved.candidates) {
			// Don't spend a backend call on an already-cancelled request — between
			// candidates the caller may have aborted (and at entry it may already be).
			signal?.throwIfAborted();
			const attemptStart = performance.now();
			try {
				const backendOpts = toBackendOpts(opts, signal, accounting);
				const result = await backend.embed!(input, backendOpts);
				// Throw on `pending` BEFORE recording success — otherwise we'd write a
				// success row followed by a failure row from the catch (duplicate).
				if (result.status !== 'completed') throw new ModelPendingNotSupportedError(backend.name);
				this.#record(backend, 'embed', opts.model, accounting, undefined, result, attemptStart);
				return { vectors: result.output, usage: result.usage };
			} catch (err) {
				this.#recordFailure(backend, 'embed', opts.model, accounting, undefined, attemptStart, err);
				if (!hasError) {
					firstError = err;
					hasError = true;
				}
				if (signal?.aborted) throw err; // caller cancelled — stop, surface the abort
			}
		}
		throw firstError;
	}

	async generate(input: GenerateInput, opts: GenerateOpts = {}): Promise<GenerateResult> {
		const hasTools = inputHasTools(input);
		if (opts.toolMode === 'auto') {
			// The loop calls back through `this.generate(..., {toolMode: 'return'})` per
			// iteration, so each backend round still flows through the single-shot path
			// below and writes its own `hdb_model_calls` row. The outer auto call itself
			// stays out of the analytics table — counting it would double-bill the round.
			const { accounting, signal } = resolveCallContext(opts.signal);
			// Fail loud, never silent: an auto loop that declares tools against a backend
			// with no tools-capable candidate would run as a plain generation, silently
			// ignoring the caller's tools. Check up front (no analytics row — no call ran).
			if (hasTools) {
				const probe = resolveCandidates('generative', opts.model, buildRequires('generate', opts.requires, true));
				if ('error' in probe) throw probe.error;
			}
			return runAgentLoop({ models: this, input, opts, accounting, signal });
		}
		const { accounting, signal } = resolveCallContext(opts.signal);
		const startedAt = performance.now();
		const resolved = resolveCandidates('generative', opts.model, buildRequires('generate', opts.requires, hasTools));
		if ('error' in resolved) {
			this.#recordFailure(resolved.backend, 'generate', opts.model, accounting, opts, startedAt, resolved.error);
			throw resolved.error;
		}
		// See embed(): fall through on any backend error (heterogeneous candidates;
		// skip-policy is a router/caller concern, #1537), surface the FIRST error if all
		// fail, abort short-circuits.
		let firstError: unknown = undefined;
		let hasError = false;
		for (const backend of resolved.candidates) {
			// Don't spend a backend call on an already-cancelled request — between
			// candidates the caller may have aborted (and at entry it may already be).
			signal?.throwIfAborted();
			const attemptStart = performance.now();
			try {
				const backendOpts = toBackendOpts(opts, signal, accounting);
				const result = await backend.generate!(input, backendOpts);
				if (result.status !== 'completed') throw new ModelPendingNotSupportedError(backend.name);
				this.#record(backend, 'generate', opts.model, accounting, opts, result, attemptStart);
				// Propagate usage onto the returned GenerateResult so callers (notably the
				// `toolMode: 'auto'` loop's budget tracker) can read cumulative tokens without
				// re-querying analytics. Pure pass-through — backend usage is the source of truth.
				return result.usage ? { ...result.output, usage: result.usage } : result.output;
			} catch (err) {
				this.#recordFailure(backend, 'generate', opts.model, accounting, opts, attemptStart, err);
				if (!hasError) {
					firstError = err;
					hasError = true;
				}
				if (signal?.aborted) throw err; // caller cancelled — stop, surface the abort
			}
		}
		throw firstError;
	}

	generateStream(input: GenerateInput, opts: GenerateOpts = {}): AsyncIterable<GenerateChunk> {
		const hasTools = inputHasTools(input);
		if (opts.toolMode === 'auto') {
			// Same rationale as `generate`: per-iteration analytics happen inside the loop
			// when it dispatches to `this.generateStream(..., {toolMode: 'return'})`.
			const { accounting, signal } = resolveCallContext(opts.signal);
			// Same fail-loud guard as `generate`, thrown synchronously before the iterable.
			if (hasTools) {
				const probe = resolveCandidates('generative', opts.model, buildRequires('stream', opts.requires, true));
				if ('error' in probe) throw probe.error;
			}
			return runAgentLoopStream({ models: this, input, opts, accounting, signal });
		}
		const { accounting, signal } = resolveCallContext(opts.signal);
		const startedAt = performance.now();
		// Resolved synchronously so an unknown model / unmet capability throws up front
		// (before the iterable is returned), and a billing row is still recorded.
		const resolved = resolveCandidates('generative', opts.model, buildRequires('stream', opts.requires, hasTools));
		if ('error' in resolved) {
			this.#recordFailure(resolved.backend, 'generateStream', opts.model, accounting, opts, startedAt, resolved.error);
			throw resolved.error;
		}
		// First candidate only — mid-stream fallback would mean replaying already-yielded chunks.
		const backend = resolved.candidates[0];
		const backendOpts = toBackendOpts(opts, signal, accounting);
		return this.#wrapStream(backend, input, backendOpts, opts, accounting, startedAt);
	}

	async *#wrapStream(
		backend: ModelBackend,
		input: GenerateInput,
		backendOpts: BackendOpts<GenerateOpts>,
		opts: GenerateOpts,
		accounting: AccountingContext,
		startedAt: number
	): AsyncIterable<GenerateChunk> {
		let caught: unknown;
		let completed = false;
		try {
			for await (const chunk of backend.generateStream!(input, backendOpts)) {
				yield chunk;
			}
			completed = true;
		} catch (err) {
			caught = err;
			throw err;
		} finally {
			if (completed) {
				this.#record(backend, 'generateStream', opts.model, accounting, opts, undefined, startedAt);
			} else if (caught) {
				this.#recordFailure(backend, 'generateStream', opts.model, accounting, opts, startedAt, caught);
			} else {
				// Stream terminated by the consumer (break / iter.return()) without an error
				// from the backend. Treat as an aborted call rather than success — the model
				// did real work that the caller didn't consume.
				this.#recordFailure(backend, 'generateStream', opts.model, accounting, opts, startedAt, 'aborted');
			}
		}
	}

	/**
	 * Choose from the closed set `schema` defines, with the distribution over it (#2779). A malformed
	 * schema or state rejects before routing, with no analytics row: nothing was called.
	 */
	async decide<T = unknown>(state: DecideInput, schema: DecisionSchema, opts: DecideOpts = {}): Promise<Decision<T>> {
		validateDecisionSchema(schema);
		stateToText(state);
		const { accounting, signal } = resolveCallContext(opts.signal);
		const startedAt = performance.now();
		const resolved = resolveCandidates('decision', opts.model, buildRequires('decide', opts.requires, false));
		if ('error' in resolved) {
			this.#recordFailure(resolved.backend, 'decide', opts.model, accounting, undefined, startedAt, resolved.error);
			throw resolved.error;
		}
		let firstError: unknown = undefined;
		let hasError = false;
		for (const backend of resolved.candidates) {
			signal?.throwIfAborted();
			const attemptStart = performance.now();
			try {
				const backendOpts = toBackendOpts(opts, signal, accounting);
				const result = await backend.decide!(state, schema, backendOpts);
				if (result.status !== 'completed') throw new ModelPendingNotSupportedError(backend.name);
				const calibrated = backend.capabilities()?.calibrated === true;
				const decision = normalizeDecision<T>(schema, result.output, backend.name, calibrated);
				// A backend may report a single call as uncalibrated; the caller's requirement still holds.
				if (!decision.calibrated && opts.requires?.includes('calibrated'))
					throw new DecisionContractError(
						backend.name,
						"probabilities are not calibrated, but 'calibrated' was required"
					);
				const id = this.#record(backend, 'decide', opts.model, accounting, undefined, result, attemptStart);
				return result.usage ? { id: String(id), ...decision, usage: result.usage } : { id: String(id), ...decision };
			} catch (err) {
				this.#recordFailure(backend, 'decide', opts.model, accounting, undefined, attemptStart, err);
				if (!hasError) {
					firstError = err;
					hasError = true;
				}
				if (signal?.aborted) throw err;
			}
		}
		throw firstError;
	}

	/**
	 * Score `choices` as answers to `input` with a generative backend that implements
	 * `scoreChoices` (#2838): the decision adapter's likelihood path. Routes `generative` with
	 * `scoreChoices` required, tries candidates like `embed`, and records one `scoreChoices` row
	 * per attempt; a `ChoiceScoringUnsupportedError` is recorded as `scoring_unsupported` with the
	 * usage it consumed. Internal, like `embedWithUsage`: not part of the stable models API.
	 */
	async scoreChoices(
		input: GenerateInput,
		choices: readonly string[],
		opts: ScoreChoicesOpts = {}
	): Promise<ChoiceScores & { usage?: TokenUsage }> {
		const { accounting, signal } = resolveCallContext(opts.signal);
		const startedAt = performance.now();
		const resolved = resolveCandidates('generative', opts.model, buildRequires('scoreChoices', opts.requires, false));
		if ('error' in resolved) {
			this.#recordFailure(
				resolved.backend,
				'scoreChoices',
				opts.model,
				accounting,
				undefined,
				startedAt,
				resolved.error
			);
			throw resolved.error;
		}
		// Surface the first FAILURE when every candidate fails. A decline (`ChoiceScoringUnsupportedError`)
		// is weaker news than a failure: the adapter reads a surfaced decline as permission to vote,
		// which would hide a broken fallback behind an unsupported primary. Only when every candidate
		// declined is the primary's decline what the caller gets.
		let firstError: unknown = undefined;
		let hasError = false;
		let firstFailure: unknown = undefined;
		let hasFailure = false;
		for (const backend of resolved.candidates) {
			signal?.throwIfAborted();
			const attemptStart = performance.now();
			try {
				// A router may hand back a backend whose capabilities claim more than it implements;
				// that is this backend's contract failure, recorded against it, not a crash.
				if (typeof backend.scoreChoices !== 'function')
					throw new ServerError(`Backend '${backend.name}' advertises 'scoreChoices' but does not implement it`);
				const result = await backend.scoreChoices(input, choices, toBackendOpts(opts, signal, accounting));
				if (result.status !== 'completed') throw new ModelPendingNotSupportedError(backend.name);
				const logLikelihoods = result.output?.logLikelihoods;
				if (
					!Array.isArray(logLikelihoods) ||
					logLikelihoods.length !== choices.length ||
					!logLikelihoods.every((x) => typeof x === 'number' && Number.isFinite(x))
				)
					throw new ServerError(
						`Backend '${backend.name}' did not return one finite log-likelihood per choice (${choices.length})`
					);
				this.#record(backend, 'scoreChoices', opts.model, accounting, undefined, result, attemptStart);
				return result.usage ? { logLikelihoods, usage: result.usage } : { logLikelihoods };
			} catch (err) {
				// Only this attempt's own decline bills its tokens: the error may travel on as an abort
				// reason or through the decision adapter, and those rows must not count it again.
				this.#recordFailure(
					backend,
					'scoreChoices',
					opts.model,
					accounting,
					undefined,
					attemptStart,
					err,
					usageFromError(err)
				);
				if (!hasError) {
					firstError = err;
					hasError = true;
				}
				if (!hasFailure && !isChoiceScoringUnsupported(err)) {
					firstFailure = err;
					hasFailure = true;
				}
				if (signal?.aborted) throw err;
			}
		}
		throw hasFailure ? firstFailure : firstError;
	}

	#record(
		backend: ModelBackend,
		method: CallMethod,
		model: string | undefined,
		accounting: AccountingContext,
		opts: GenerateOpts | undefined,
		result: ModelCallResult<unknown> | undefined,
		startedAt: number
	): number {
		const usage = result?.status === 'completed' ? result.usage : undefined;
		const id = this.#analyticsWriter.write(
			buildRecord(backend, method, model, accounting, opts, usage, startedAt, true)
		);
		// Also emit aggregate analytics into hdb_raw_analytics so model usage rolls up
		// into the same per-period analytics that license enforcement and admin
		// dashboards consume — mirrors the `db-read` pattern in Table.ts. The detailed
		// per-call row in hdb_model_calls (above) is for forensics; this is for billing.
		// Path is the backend name (analogous to tableName for db-read) so dashboards
		// can break usage down by backend.
		this.#emit(1, `model-${method}`, backend.name);
		this.#emitTokens(method, backend.name, usage);
		return id;
	}

	#emitTokens(method: CallMethod, backendName: string, usage: TokenUsage | undefined): void {
		if (!usage) return;
		const tokens = (usage.embeddingTokens ?? 0) + (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
		if (tokens > 0) this.#emit(tokens, `model-${method}-tokens`, backendName);
	}

	#recordFailure(
		backend: ModelBackend | undefined,
		method: CallMethod,
		model: string | undefined,
		accounting: AccountingContext,
		opts: GenerateOpts | undefined,
		startedAt: number,
		errOrCode: unknown,
		usage?: TokenUsage
	): void {
		const error_code = typeof errOrCode === 'string' ? errOrCode : classifyError(errOrCode);
		this.#analyticsWriter.write({
			...buildRecord(backend, method, model, accounting, opts, usage, startedAt, false),
			error_code,
		});
		if (backend) this.#emitTokens(method, backend.name, usage);
	}
}

function isChoiceScoringUnsupported(err: unknown): boolean {
	return (err as { name?: string } | null)?.name === 'ChoiceScoringUnsupportedError';
}

/**
 * Tokens a declined scoring call consumed (`ChoiceScoringUnsupportedError.usage`), finite counts
 * only: a completion that came back without log-probabilities was billed, so they land on that
 * attempt's failure row and in the token metric while the call-count metric stays a count of
 * successes. No other error's `usage` is read, and no other method's failure row carries usage.
 */
function usageFromError(err: unknown): TokenUsage | undefined {
	if (!isChoiceScoringUnsupported(err)) return undefined;
	const reported = (err as { usage?: unknown }).usage;
	if (!reported || typeof reported !== 'object') return undefined;
	const usage: TokenUsage = {};
	for (const key of ['promptTokens', 'completionTokens', 'embeddingTokens'] as const)
		assignFiniteTokenCount(usage, key, (reported as Record<string, unknown>)[key]);
	return Object.keys(usage).length > 0 ? usage : undefined;
}

function buildRecord(
	backend: ModelBackend | undefined,
	method: CallMethod,
	model: string | undefined,
	accounting: AccountingContext,
	opts: GenerateOpts | undefined,
	usage: TokenUsage | undefined,
	startedAt: number,
	success: boolean
): ModelCallRecord {
	const record: ModelCallRecord = {
		backend: backend?.name ?? 'unknown',
		method,
		model,
		tenant: accounting.tenantId,
		app: accounting.app,
		adapter: opts?.adapter,
		conversation_id: opts?.conversationId,
		latency_ms: performance.now() - startedAt,
		success,
	};
	if (usage) {
		if (usage.promptTokens !== undefined) record.prompt_tokens = usage.promptTokens;
		if (usage.completionTokens !== undefined) record.completion_tokens = usage.completionTokens;
		if (usage.embeddingTokens !== undefined) record.embedding_tokens = usage.embeddingTokens;
		if (usage.gpuMs !== undefined) record.gpu_ms = usage.gpuMs;
	}
	return record;
}

function resolveCallContext(callerSignal?: AbortSignal): { accounting: AccountingContext; signal?: AbortSignal } {
	const ctx = contextStorage.getStore();
	return {
		accounting: {
			tenantId: extractTenantId(ctx?.user),
			app: ctx?.handlerPath,
		},
		signal: callerSignal ?? ctx?.signal,
	};
}

function extractTenantId(user: any): string | undefined {
	return user?.tenant ?? user?.tenantId ?? undefined;
}

/** True when `input` is the object form carrying a non-empty `tools` array. */
function inputHasTools(input: GenerateInput): boolean {
	return typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.tools) && input.tools.length > 0;
}

type Resolution = { candidates: ModelBackend[] } | { error: Error; backend: ModelBackend | undefined };

/**
 * Resolve a call to its ordered candidate backends via the active router (#1326),
 * or to the error to record + throw. Preserves the facade's pre-router semantics:
 * an unmapped logical name → `ModelBackendNotFoundError` (recorded as `unknown`);
 * a mapped backend that can't satisfy `requires` → `ModelCapabilityError` naming
 * that backend. The router does the capability filtering; this reconstructs the
 * distinction for the empty case. A custom router that returns empty for a backend
 * that *does* satisfy `requires` is a routing decision, not a capability gap, so it
 * surfaces as a plain "no candidates" error — not a misleading `ModelCapabilityError`
 * against a backend that actually supports the call (the default router never returns
 * empty for a satisfying primary; it only drops on name or capability miss).
 */
/**
 * Builds the options passed to a backend call. `opts.model` is the LOGICAL name — it selects
 * the configured entry via resolveCandidates and must not reach the backend, where it would
 * override the entry's configured wire model id (#1593: `@embed(model: "default")` sent the
 * literal string "default" to the provider). Backends always use their own configured model.
 */
function toBackendOpts<TOpts extends { model?: string; signal?: AbortSignal }>(
	opts: TOpts,
	signal: AbortSignal | undefined,
	accounting: AccountingContext
): BackendOpts<TOpts> {
	const backendOpts = { ...opts, signal, accounting };
	delete backendOpts.model;
	return backendOpts;
}

function resolveCandidates(kind: ModelKind, model: string | undefined, requires: Capability[]): Resolution {
	const logicalName = model ?? 'default';
	const candidates = getRouter().route({ kind, logicalName, requires });
	if (candidates.length > 0) return { candidates };
	const primary = getBackend(kind, logicalName);
	if (!primary) return { error: new ModelBackendNotFoundError(kind, logicalName), backend: undefined };
	// `caps?.[…]` guards a custom backend whose capabilities() returns nullish — a
	// missing capabilities object means it satisfies nothing, so it reads as unmet.
	const caps = primary.capabilities();
	const unmet = requires.find((capability) => !caps?.[capability]);
	if (unmet) return { error: new ModelCapabilityError(primary.name, unmet), backend: primary };
	return { error: new ServerError(`No routing candidates available for model '${logicalName}'`), backend: primary };
}

/** Capabilities a call requires: its base method, the caller's `requires`, and `tools` when the input declares them. */
function buildRequires(base: Capability, requires: Capability[] | undefined, includeTools: boolean): Capability[] {
	const set = new Set<Capability>([base, ...(requires ?? [])]);
	if (includeTools) set.add('tools');
	return [...set];
}

function classifyError(err: unknown): string {
	if (err && typeof err === 'object') {
		const e = err as { name?: string; code?: string };
		if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return 'aborted';
		if (e.name === 'ModelCapabilityError') return 'capability_unsupported';
		if (e.name === 'ChoiceScoringUnsupportedError') return 'scoring_unsupported';
		if (e.name === 'ModelBackendNotFoundError') return 'backend_not_found';
		if (e.name === 'ModelPendingNotSupportedError') return 'pending_unsupported';
	}
	return 'backend_error';
}

export class ModelCapabilityError extends ServerError {
	// Deliberately does not name the requested capability beyond what was asked for —
	// avoids enumerating what the backend *does* support in error responses.
	constructor(backendName: string, capability: Capability) {
		super(`Backend '${backendName}' does not support '${capability}'`);
		this.name = 'ModelCapabilityError';
	}
}

export class ModelPendingNotSupportedError extends ServerError {
	constructor(backendName: string) {
		super(`Backend '${backendName}' returned 'pending'; long-running operations are not yet supported`);
		this.name = 'ModelPendingNotSupportedError';
	}
}

/**
 * Process-wide `Models` singleton exposed to user code as the `models` global
 * (and as `import { models } from 'harperdb'`).  The Models class itself holds
 * no per-Scope or per-ApplicationScope state — the backend registry it reads
 * from is process-wide and accounting context comes from ALS — so one shared
 * instance is observationally identical to the per-Scope instances built in
 * `components/Scope.ts`, with the advantage that user resources can call
 * `models.embed(...)` without writing a `handleApplication` shim that stashes
 * `scope.models` on a global.
 */
export const models = new Models();
_assignPackageExport('models', models);
// The backend-registration API is reachable as `models.registerBackend(...)` /
// `models.defineBackend(...)` — methods on the `models` singleton above, not generic
// free globals (#1534). Custom routers install via `models.registerRouter(...)` (#1326).
