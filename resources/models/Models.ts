import { _assignPackageExport } from '../../globals.js';
import { contextStorage } from '../transaction.ts';
import { resolveEmbedding, resolveGenerative } from './backendRegistry.ts';
import { getModelCallAnalyticsWriter, type ModelCallAnalyticsWriter, type ModelCallRecord } from './analyticsTable.ts';
import { recordAction } from '../analytics/write.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';
import { runAgentLoop, runAgentLoopStream } from './agentLoop.ts';
import type {
	AccountingContext,
	BackendOpts,
	EmbedOpts,
	GenerateChunk,
	GenerateInput,
	GenerateOpts,
	GenerateResult,
	ModelBackend,
	ModelCallResult,
	Models as ModelsContract,
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

	async embed(input: string | string[], opts: EmbedOpts = {}): Promise<Float32Array[]> {
		const { accounting, signal } = resolveCallContext(opts.signal);
		const startedAt = performance.now();
		let backend: ModelBackend | undefined;
		try {
			backend = resolveEmbedding(opts.model);
			requireCapability(backend, 'embed');
			const backendOpts: BackendOpts<EmbedOpts> = { ...opts, signal, accounting };
			const result = await backend.embed!(input, backendOpts);
			// Throw on `pending` BEFORE recording success — otherwise we'd write a
			// success row followed by a failure row from the catch (duplicate).
			if (result.status !== 'completed') throw new ModelPendingNotSupportedError(backend.name);
			this.#record(backend, 'embed', opts.model, accounting, undefined, result, startedAt);
			return result.output;
		} catch (err) {
			this.#recordFailure(backend, 'embed', opts.model, accounting, undefined, startedAt, err);
			throw err;
		}
	}

	async generate(input: GenerateInput, opts: GenerateOpts = {}): Promise<GenerateResult> {
		if (opts.toolMode === 'auto') {
			// The loop calls back through `this.generate(..., {toolMode: 'return'})` per
			// iteration, so each backend round still flows through the single-shot path
			// below and writes its own `hdb_model_calls` row. The outer auto call itself
			// stays out of the analytics table — counting it would double-bill the round.
			const { accounting, signal } = resolveCallContext(opts.signal);
			// Fail loud, never silent: an auto loop that declares tools against a
			// tools-incapable backend would run as a plain generation — the backend never
			// receives the tool definitions (e.g. ollama drops them), so the model can't
			// call anything and the loop returns a first-round answer, silently ignoring
			// the caller's tools. Check up front rather than no-op.
			if (inputHasTools(input)) requireCapability(resolveGenerative(opts.model), 'tools');
			return runAgentLoop({ models: this, input, opts, accounting, signal });
		}
		const { accounting, signal } = resolveCallContext(opts.signal);
		const startedAt = performance.now();
		let backend: ModelBackend | undefined;
		try {
			backend = resolveGenerative(opts.model);
			requireCapability(backend, 'generate');
			const backendOpts: BackendOpts<GenerateOpts> = { ...opts, signal, accounting };
			const result = await backend.generate!(input, backendOpts);
			if (result.status !== 'completed') throw new ModelPendingNotSupportedError(backend.name);
			this.#record(backend, 'generate', opts.model, accounting, opts, result, startedAt);
			// Propagate usage onto the returned GenerateResult so callers (notably the
			// `toolMode: 'auto'` loop's budget tracker) can read cumulative tokens without
			// re-querying analytics. Pure pass-through — backend usage is the source of truth.
			return result.usage ? { ...result.output, usage: result.usage } : result.output;
		} catch (err) {
			this.#recordFailure(backend, 'generate', opts.model, accounting, opts, startedAt, err);
			throw err;
		}
	}

	generateStream(input: GenerateInput, opts: GenerateOpts = {}): AsyncIterable<GenerateChunk> {
		if (opts.toolMode === 'auto') {
			// Same rationale as `generate`: per-iteration analytics happen inside the loop
			// when it dispatches to `this.generateStream(..., {toolMode: 'return'})`.
			const { accounting, signal } = resolveCallContext(opts.signal);
			// Same fail-loud guard as `generate` — a tools-incapable backend would silently
			// stream a plain generation, ignoring the declared tools. Throws synchronously
			// (before the iterable is returned), matching the capability-check posture below.
			if (inputHasTools(input)) requireCapability(resolveGenerative(opts.model), 'tools');
			return runAgentLoopStream({ models: this, input, opts, accounting, signal });
		}
		const { accounting, signal } = resolveCallContext(opts.signal);
		const startedAt = performance.now();
		let backend: ModelBackend | undefined;
		try {
			backend = resolveGenerative(opts.model);
			requireCapability(backend, 'stream');
		} catch (err) {
			// Record pre-call failure synchronously so callers that hold but never
			// iterate the returned iterable still produce a billing row, then rethrow.
			// Pass `backend` (not `undefined`): when the registry hit but the capability
			// check failed, `backend` is the resolved instance and its name belongs in
			// the row. Only registry misses leave `backend` undefined → 'unknown'.
			this.#recordFailure(backend, 'generateStream', opts.model, accounting, opts, startedAt, err);
			throw err;
		}
		const backendOpts: BackendOpts<GenerateOpts> = { ...opts, signal, accounting };
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

	#record(
		backend: ModelBackend,
		method: CallMethod,
		model: string | undefined,
		accounting: AccountingContext,
		opts: GenerateOpts | undefined,
		result: ModelCallResult<unknown> | undefined,
		startedAt: number
	): void {
		const usage = result?.status === 'completed' ? result.usage : undefined;
		this.#analyticsWriter.write(buildRecord(backend, method, model, accounting, opts, usage, startedAt, true));
		// Also emit aggregate analytics into hdb_raw_analytics so model usage rolls up
		// into the same per-period analytics that license enforcement and admin
		// dashboards consume — mirrors the `db-read` pattern in Table.ts. The detailed
		// per-call row in hdb_model_calls (above) is for forensics; this is for billing.
		// Path is the backend name (analogous to tableName for db-read) so dashboards
		// can break usage down by backend.
		this.#emit(1, `model-${method}`, backend.name);
		if (usage) {
			const tokens = (usage.embeddingTokens ?? 0) + (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
			if (tokens > 0) this.#emit(tokens, `model-${method}-tokens`, backend.name);
		}
	}

	#recordFailure(
		backend: ModelBackend | undefined,
		method: CallMethod,
		model: string | undefined,
		accounting: AccountingContext,
		opts: GenerateOpts | undefined,
		startedAt: number,
		errOrCode: unknown
	): void {
		const error_code = typeof errOrCode === 'string' ? errOrCode : classifyError(errOrCode);
		this.#analyticsWriter.write({
			...buildRecord(backend, method, model, accounting, opts, undefined, startedAt, false),
			error_code,
		});
	}
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

function requireCapability(backend: ModelBackend, capability: 'embed' | 'generate' | 'stream' | 'tools'): void {
	if (!backend.capabilities()[capability]) throw new ModelCapabilityError(backend.name, capability);
}

function classifyError(err: unknown): string {
	if (err && typeof err === 'object') {
		const e = err as { name?: string; code?: string };
		if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return 'aborted';
		if (e.name === 'ModelCapabilityError') return 'capability_unsupported';
		if (e.name === 'ModelBackendNotFoundError') return 'backend_not_found';
		if (e.name === 'ModelPendingNotSupportedError') return 'pending_unsupported';
	}
	return 'backend_error';
}

export class ModelCapabilityError extends ServerError {
	// Deliberately does not name the requested capability beyond what was asked for —
	// avoids enumerating what the backend *does* support in error responses.
	constructor(backendName: string, capability: 'embed' | 'generate' | 'stream' | 'tools') {
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
