/**
 * Engine-specific error types for the new SQL engine.
 *
 * EngineUnsupportedError is thrown by the planner when a query shape cannot be
 * mapped to the Resource API efficiently. The router catches this in 'auto'
 * mode and falls back to the legacy AlaSQL engine.
 *
 * EngineRuntimeError is thrown during execution for runtime conditions
 * (e.g., exceeding the in-memory sort/hash row caps).
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
