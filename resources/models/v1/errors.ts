/**
 * OpenAI error envelope helpers for the `/v1/*` gateway (#631).
 *
 * Harper's REST layer serialises uncaught errors as RFC 9457 Problem Details.
 * Resources that need the OpenAI `{ error: { message, type, code, param } }`
 * shape must catch errors themselves and call `toOpenAIError()` / `badRequest()`.
 */

import { ModelBackendNotFoundError } from '../backendRegistry.ts';

type OpenAIErrorType =
	| 'invalid_request_error'
	| 'server_error'
	| 'authentication_error'
	| 'permission_error'
	| 'api_error';

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

/**
 * Gate for the `/v1/*` handlers, since overriding the static `get`/`post` methods
 * bypasses Resource's `transactional()` wrapper and its default `allowRead`/`allowCreate`
 * checks (Resource.ts:685-733, 426-435) never run for these endpoints.
 *
 * Mirrors Resource's default gate (super_user-only) rather than introducing a new
 * permission — see PR discussion for whether a dedicated `/v1/*` permission should
 * replace this later.
 *
 * Returns an OpenAI-shape error response when access should be denied, or `null`
 * when the request may proceed.
 */
export function authorizeV1Request(request: {
	user?: { role?: { permission?: { super_user?: boolean } } };
}): OpenAIErrorResponse | null {
	const user = request?.user;
	if (!user) {
		return {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
			data: {
				error: {
					message: 'You must provide valid credentials to access this endpoint.',
					type: 'authentication_error' as const,
					code: null,
					param: null,
				},
			},
		};
	}
	if (!user.role?.permission?.super_user) {
		return {
			status: 403,
			headers: { 'Content-Type': 'application/json' },
			data: {
				error: {
					message: 'You do not have permission to access this endpoint.',
					type: 'permission_error' as const,
					code: null,
					param: null,
				},
			},
		};
	}
	return null;
}
