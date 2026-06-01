const assert = require('node:assert/strict');
const {
	JSONRPC_VERSION,
	ERROR_CODES,
	parseMessage,
	isClientFireAndForget,
	buildSuccess,
	buildError,
} = require('#src/components/mcp/jsonrpc');

describe('mcp/jsonrpc', () => {
	describe('parseMessage', () => {
		it('parses a well-formed request', () => {
			const result = parseMessage('{"jsonrpc":"2.0","id":1,"method":"foo","params":{"a":1}}');
			assert.equal(result.ok, true);
			assert.deepEqual(result.message, { jsonrpc: '2.0', id: 1, method: 'foo', params: { a: 1 } });
		});

		it('parses a notification (no id)', () => {
			const result = parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
			assert.equal(result.ok, true);
			assert.equal(result.message.method, 'notifications/initialized');
		});

		it('parses a success response', () => {
			const result = parseMessage('{"jsonrpc":"2.0","id":2,"result":{"x":1}}');
			assert.equal(result.ok, true);
		});

		it('parses an error response', () => {
			const result = parseMessage('{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"x"}}');
			assert.equal(result.ok, true);
		});

		it('returns PARSE_ERROR on invalid JSON', () => {
			const result = parseMessage('{not json');
			assert.equal(result.ok, false);
			assert.equal(result.code, ERROR_CODES.PARSE_ERROR);
		});

		it('returns INVALID_REQUEST when body is an array (batches not supported)', () => {
			const result = parseMessage('[{"jsonrpc":"2.0","id":1,"method":"foo"}]');
			assert.equal(result.ok, false);
			assert.equal(result.code, ERROR_CODES.INVALID_REQUEST);
		});

		it('returns INVALID_REQUEST when body is not an object', () => {
			assert.equal(parseMessage('null').ok, false);
			assert.equal(parseMessage('42').ok, false);
			assert.equal(parseMessage('"str"').ok, false);
		});

		it('returns INVALID_REQUEST when jsonrpc field is wrong', () => {
			const result = parseMessage('{"jsonrpc":"1.0","id":1,"method":"foo"}');
			assert.equal(result.ok, false);
			assert.equal(result.code, ERROR_CODES.INVALID_REQUEST);
		});

		it('returns INVALID_REQUEST when method, result, and error are all missing', () => {
			const result = parseMessage('{"jsonrpc":"2.0","id":1}');
			assert.equal(result.ok, false);
			assert.equal(result.code, ERROR_CODES.INVALID_REQUEST);
		});
	});

	describe('isClientFireAndForget', () => {
		it('is true for a notification (no id)', () => {
			assert.equal(isClientFireAndForget({ jsonrpc: '2.0', method: 'foo' }), true);
		});

		it('is true for a success response (has result, even with id)', () => {
			assert.equal(isClientFireAndForget({ jsonrpc: '2.0', id: 1, result: 'ok' }), true);
		});

		it('is true for an error response', () => {
			assert.equal(isClientFireAndForget({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }), true);
		});

		it('is false for a real request (has id and method)', () => {
			assert.equal(isClientFireAndForget({ jsonrpc: '2.0', id: 1, method: 'foo' }), false);
		});
	});

	describe('buildSuccess', () => {
		it('shapes a success response', () => {
			assert.deepEqual(buildSuccess(7, { foo: 'bar' }), {
				jsonrpc: '2.0',
				id: 7,
				result: { foo: 'bar' },
			});
		});
	});

	describe('buildError', () => {
		it('shapes an error response without data', () => {
			assert.deepEqual(buildError(7, ERROR_CODES.METHOD_NOT_FOUND, 'nope'), {
				jsonrpc: '2.0',
				id: 7,
				error: { code: -32601, message: 'nope' },
			});
		});

		it('includes data when provided', () => {
			const err = buildError(7, ERROR_CODES.INVALID_PARAMS, 'bad', { field: 'x' });
			assert.deepEqual(err.error, { code: -32602, message: 'bad', data: { field: 'x' } });
		});
	});

	it('exports the JSONRPC_VERSION constant', () => {
		assert.equal(JSONRPC_VERSION, '2.0');
	});
});
