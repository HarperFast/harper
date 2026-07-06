/**
 * OpenAI error envelope helpers for the `/v1/*` gateway (#631).
 *
 * Harper's REST layer serialises uncaught errors as RFC 9457 Problem Details.
 * Resources that need the OpenAI `{ error: { message, type, code, param } }`
 * shape must catch errors themselves and call `toOpenAIError()` / `badRequest()`.
 */

import { ModelBackendNotFoundError } from '../backendRegistry.ts';

type OpenAIErrorType = 'invalid_request_error' | 'server_error' | 'authentication_error' | 'api_error';

export interface OpenAIErrorBody {
	message: string;
	type: OpenAIErrorType;
	code: string | null;
	param: string | null;
}

/** HTTP response payload from a gateway error; resource methods return this directly. */
export interface OpenAIErrorResponse {
	status: number;
	headers: { 'Content-Type': 'application/json' };
	data: { error: OpenAIErrorBody };
}

/**
 * Map any thrown value to an OpenAI error envelope. Uses `statusCode` when
 * present (Harper's `ClientError` / `ServerError` convention). Falls back to
 * `500 server_error`. `ModelBackendNotFoundError` maps to `404 model_not_found`.
 */
export function toOpenAIError(err: unknown): OpenAIErrorResponse {
	const message = err instanceof Error ? err.message : 'Internal server error';
	let status = 500;
	let type: OpenAIErrorType = 'server_error';
	let code: string | null = null;

	if (err instanceof ModelBackendNotFoundError) {
		status = 404;
		type = 'invalid_request_error';
		code = 'model_not_found';
	} else if (err instanceof Error && typeof (err as any).statusCode === 'number') {
		status = (err as any).statusCode;
		if (status === 401 || status === 403) {
			type = 'authentication_error';
		} else if (status < 500) {
			type = 'invalid_request_error';
		} else {
			type = 'server_error';
		}
	}

	return {
		status,
		headers: { 'Content-Type': 'application/json' },
		data: { error: { message, type, code, param: null } },
	};
}

/** Convenience for early request-body validation failures. */
export function badRequest(message: string): OpenAIErrorResponse {
	return {
		status: 400,
		headers: { 'Content-Type': 'application/json' },
		data: { error: { message, type: 'invalid_request_error', code: null, param: null } },
	};
}
