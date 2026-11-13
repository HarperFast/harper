'use strict';

const assert = require('node:assert');
const { operationErrorResponse } = require('#src/server/serverHelpers/operationErrorResponse');
const { ClientError, handleHDBError, hdbErrors } = require('#src/utility/errors/hdbError');

describe('operationErrorResponse', () => {
	it('answers a status-bearing error with its message', () => {
		assert.deepStrictEqual(operationErrorResponse(new ClientError('nope', 409)), {
			statusCode: 409,
			body: { error: 'nope' },
		});
	});

	it('passes a structured response message through as the body', () => {
		const error = handleHDBError(new Error(), { error: 'mismatch', custody_fingerprint: 'abc' }, 409);
		assert.deepStrictEqual(operationErrorResponse(error), {
			statusCode: 409,
			body: { error: 'mismatch', custody_fingerprint: 'abc' },
		});
	});

	it('carries the retry signal of an error that declares one', () => {
		const error = Object.assign(new ClientError('building', 503), { code: 'INDEX_REBUILDING', retryable: true });
		assert.deepStrictEqual(operationErrorResponse(error), {
			statusCode: 503,
			body: { error: 'building', code: 'INDEX_REBUILDING', retryable: true },
		});
	});

	it('answers 500 for an error with no status, a string, and no error at all', () => {
		assert.deepStrictEqual(operationErrorResponse(new Error('boom')), { statusCode: 500, body: { error: 'boom' } });
		assert.deepStrictEqual(operationErrorResponse('text'), { statusCode: 500, body: { error: 'text' } });
		assert.deepStrictEqual(operationErrorResponse(undefined), {
			statusCode: 500,
			body: { error: hdbErrors.DEFAULT_ERROR_MSGS[500] },
		});
	});
});
