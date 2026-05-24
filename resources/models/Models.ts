import { _assignPackageExport } from '../../globals.js';
import { contextStorage } from '../transaction.ts';
import { resolveEmbedding, resolveGenerative } from './backendRegistry.ts';
import { getModelCallAnalyticsWriter, type ModelCallAnalyticsWriter, type ModelCallRecord } from './analyticsTable.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';
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

/**
 * Public `scope.models` facade. One instance per `Scope`.
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

	constructor(analyticsWriter: ModelCallAnalyticsWriter = getModelCallAnalyticsWriter()) {
		this.#analyticsWriter = analyticsWriter;
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
			return result.output;
		} catch (err) {
			this.#recordFailure(backend, 'generate', opts.model, accounting, opts, startedAt, err);
			throw err;
		}
	}

	generateStream(input: GenerateInput, opts: GenerateOpts = {}): AsyncIterable<GenerateChunk> {
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

function requireCapability(backend: ModelBackend, capability: 'embed' | 'generate' | 'stream'): void {
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
	constructor(backendName: string, capability: 'embed' | 'generate' | 'stream') {
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
