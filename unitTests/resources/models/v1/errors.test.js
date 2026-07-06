'use strict';

/**
 * Unit tests for `resources/models/v1/errors.ts` (#631).
 *
 * Verifies OpenAI error envelope construction without I/O.
 */

const assert = require('node:assert');
const { toOpenAIError, badRequest, authorizeV1Request } = require('#src/resources/models/v1/errors');
const { ModelBackendNotFoundError } = require('#src/resources/models/backendRegistry');

function makeClientError(message, statusCode) {
	const err = new Error(message);
	err.statusCode = statusCode;
	return err;
}

describe('toOpenAIError', () => {
	it('maps ModelBackendNotFoundError to 404 model_not_found', () => {
		const err = new ModelBackendNotFoundError('generative', 'missing-model');
		const resp = toOpenAIError(err);
		assert.equal(resp.status, 404);
		assert.equal(resp.data.error.type, 'invalid_request_error');
		assert.equal(resp.data.error.code, 'model_not_found');
		assert.ok(resp.data.error.message.includes('missing-model'));
	});

	it('maps 400 statusCode errors to invalid_request_error', () => {
		const resp = toOpenAIError(makeClientError('bad input', 400));
		assert.equal(resp.status, 400);
		assert.equal(resp.data.error.type, 'invalid_request_error');
		assert.equal(resp.data.error.code, null);
	});

	it('maps 401 statusCode to authentication_error', () => {
		const resp = toOpenAIError(makeClientError('unauthorized', 401));
		assert.equal(resp.status, 401);
		assert.equal(resp.data.error.type, 'authentication_error');
	});

	it('maps 403 statusCode to authentication_error', () => {
		const resp = toOpenAIError(makeClientError('forbidden', 403));
		assert.equal(resp.status, 403);
		assert.equal(resp.data.error.type, 'authentication_error');
	});

	it('maps 500 statusCode to server_error', () => {
		const resp = toOpenAIError(makeClientError('boom', 500));
		assert.equal(resp.status, 500);
		assert.equal(resp.data.error.type, 'server_error');
	});

	it('defaults to 500 server_error for unknown errors', () => {
		const resp = toOpenAIError(new Error('surprise'));
		assert.equal(resp.status, 500);
		assert.equal(resp.data.error.type, 'server_error');
	});

	it('uses a fallback message for non-Error throws', () => {
		const resp = toOpenAIError('string error');
		assert.equal(resp.data.error.message, 'Internal server error');
	});

	it('always sets param to null', () => {
		const resp = toOpenAIError(new Error('x'));
		assert.equal(resp.data.error.param, null);
	});

	it('sets Content-Type application/json header', () => {
		const resp = toOpenAIError(new Error('x'));
		assert.equal(resp.headers['Content-Type'], 'application/json');
	});
});

describe('badRequest', () => {
	it('returns 400 invalid_request_error with the supplied message', () => {
		const resp = badRequest('field missing');
		assert.equal(resp.status, 400);
		assert.equal(resp.data.error.type, 'invalid_request_error');
		assert.equal(resp.data.error.message, 'field missing');
		assert.equal(resp.data.error.code, null);
		assert.equal(resp.data.error.param, null);
	});
});

describe('authorizeV1Request', () => {
	it('returns a 401 authentication_error envelope when request.user is absent', () => {
		const resp = authorizeV1Request({});
		assert.equal(resp.status, 401);
		assert.equal(resp.data.error.type, 'authentication_error');
	});

	it('returns a 403 permission_error envelope for a non-super_user', () => {
		const resp = authorizeV1Request({ user: { role: { permission: { super_user: false } } } });
		assert.equal(resp.status, 403);
		assert.equal(resp.data.error.type, 'permission_error');
	});

	it('returns null (allow) for a super_user', () => {
		const resp = authorizeV1Request({ user: { role: { permission: { super_user: true } } } });
		assert.equal(resp, null);
	});
});
