/**
 * In-process tool-call agent loop for `Models.generate({ toolMode: 'auto' })`.
 *
 * Wiring (commit 1 of #612): type surface + guarded entry point. `Models.generate`
 * branches on `opts.toolMode === 'auto'` and delegates here; both entry points
 * currently throw `ServerError(501)` so the contract is type-declared and call-site
 * wired, but the loop body lands in subsequent commits. Tests assert the throw
 * and the new option-field shapes flow through unchanged.
 *
 * Subsequent commits fill in:
 *   commit 2 — core sequential loop (handler dispatch, result truncation, trace)
 *   commit 3 — parallel batches + abort propagation
 *   commit 4 — token/cost budgets + `toolErrorMode: 'abort'`
 *   commit 5 — streaming auto path + `opts.conversation.append`
 *
 * Registry seam: v1 dispatches via caller-supplied `opts.toolHandlers`. #615
 * replaces that with a `scope.resources` lookup using the same call signature.
 */
import { ClientError, ServerError } from '../../utility/errors/hdbError.ts';
import type {
	AccountingContext,
	GenerateChunk,
	GenerateInput,
	GenerateOpts,
	GenerateResult,
	Models,
	ToolTraceEntry,
} from './types.ts';

export interface RunAgentLoopArgs {
	models: Models;
	input: GenerateInput;
	opts: GenerateOpts;
	accounting: AccountingContext;
	signal?: AbortSignal;
}

export async function runAgentLoop(_args: RunAgentLoopArgs): Promise<GenerateResult> {
	throw new ServerError("`toolMode: 'auto'` is not yet implemented", 501);
}

export async function* runAgentLoopStream(_args: RunAgentLoopArgs): AsyncIterable<GenerateChunk> {
	throw new ServerError("`toolMode: 'auto'` is not yet implemented for streaming", 501);
}

/**
 * Loop tripped one of its budgets (iterations, tokens, cost). The trace built so
 * far rides along on `partialTrace` so callers can inspect what already ran. The
 * loop always populates this regardless of `opts.includeToolTrace` so debugging an
 * exhausted budget never needs a second run with tracing turned on.
 */
export class BudgetExceededError extends ServerError {
	kind: 'iterations' | 'tokens' | 'cost';
	partialTrace: ToolTraceEntry[];
	constructor(kind: 'iterations' | 'tokens' | 'cost', message: string, partialTrace: ToolTraceEntry[]) {
		// 429 (Too Many Requests) maps cleanest to "you exceeded the budget you set".
		super(message, 429);
		this.name = 'BudgetExceededError';
		this.kind = kind;
		this.partialTrace = partialTrace;
	}
}

/**
 * `toolArgValidation: 'strict'` rejected a tool call's arguments against its
 * declared `parameters` JSON Schema. Surfaces as a 400 — the model produced output
 * that doesn't satisfy the contract the caller declared.
 */
export class ToolValidationError extends ClientError {
	toolName: string;
	toolCallId: string;
	validationErrors: object[];
	constructor(toolName: string, toolCallId: string, validationErrors: object[], message: string) {
		super(message, 400);
		this.name = 'ToolValidationError';
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.validationErrors = validationErrors;
	}
}
