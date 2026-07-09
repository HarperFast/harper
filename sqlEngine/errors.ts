/**
 * Engine-specific error types for the new SQL engine.
 *
 * EngineUnsupportedError is thrown when a query cannot be handled by the new
 * engine — either at plan time (a shape that can't map to the Resource API) or
 * at execution time (an in-memory operator exceeding its row cap, before any
 * result is emitted). The router catches this in 'auto' mode and falls back to
 * the legacy AlaSQL engine.
 *
 * EngineRuntimeError is thrown for genuine runtime failures that are NOT
 * recoverable by falling back (e.g., a mutation target with no primary key).
 * The router does not fall back on it — it surfaces to the caller.
 */

import { ClientError } from '../utility/errors/hdbError.js';

export class EngineUnsupportedError extends ClientError {
	reason: string;
	astSnippet?: unknown;

	constructor(reason: string, astSnippet?: unknown) {
		super(`SQL engine v2: unsupported query — ${reason}`);
		this.name = 'EngineUnsupportedError';
		this.reason = reason;
		this.astSnippet = astSnippet;
	}
}

export class EngineRuntimeError extends ClientError {
	constructor(message: string) {
		super(`SQL engine v2: ${message}`);
		this.name = 'EngineRuntimeError';
	}
}
