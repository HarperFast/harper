'use strict';

const assert = require('node:assert');
const { formatCliError } = require('#src/bin/harper');

describe('harper.ts formatCliError', () => {
	it('shows only the message for an expected client error (numeric statusCode), no stack', () => {
		const error = new Error("'keep_count' must be a non-negative integer");
		error.statusCode = 400;
		const out = formatCliError(error);
		assert.strictEqual(out, "error: 'keep_count' must be a non-negative integer");
		assert.ok(!out.includes('    at '), 'a client error must not print a stack trace');
	});

	it('keeps the stack for a genuinely unexpected error (no statusCode)', () => {
		const error = new Error('boom');
		const out = formatCliError(error);
		assert.match(out, /^error: boom/);
		assert.ok(out.includes(error.stack), 'unexpected errors keep their stack for debugging');
	});

	it('handles a non-Error value', () => {
		assert.strictEqual(formatCliError('plain string'), 'error: plain string');
	});
});
