const assert = require('assert');
<<<<<<< HEAD
const { IndexRebuildingError, ServerError } = require('#src/utility/errors/hdbError');
=======
const {
	appendErrorContext,
	IndexRebuildingError,
	ServerError,
	TransactionCommitConflictTimeoutError,
} = require('#src/utility/errors/hdbError');
>>>>>>> 73c3bb3bc (Settle the source-fill promise when an error's message cannot be assigned)

describe('IndexRebuildingError', () => {
	it('is a retryable 503 ServerError with a stable machine-readable code', () => {
		const err = new IndexRebuildingError('"path" is not indexed yet, can not search for this attribute');
		assert(err instanceof ServerError, 'should extend ServerError');
		assert(err instanceof Error);
		assert.equal(err.name, 'IndexRebuildingError');
		assert.equal(err.statusCode, 503);
		assert.equal(err.code, 'INDEX_REBUILDING');
		assert.equal(err.retryable, true);
		assert.equal(err.message, '"path" is not indexed yet, can not search for this attribute');
	});
});
<<<<<<< HEAD
=======

describe('TransactionCommitConflictTimeoutError', () => {
	it('is a 503 ServerError with a stable machine-readable code', () => {
		const err = new TransactionCommitConflictTimeoutError('abandoned', true);
		assert(err instanceof ServerError, 'should extend ServerError');
		assert(err instanceof Error);
		assert.strictEqual(err.name, 'TransactionCommitConflictTimeoutError');
		assert.strictEqual(err.statusCode, 503);
		assert.strictEqual(err.code, 'TRANSACTION_COMMIT_CONFLICT_TIMEOUT');
		assert.strictEqual(err.message, 'abandoned');
	});

	// Retryability is per-instance, not per-class: a multi-store transaction whose earlier store
	// already committed must not advertise a retry that would replay that store's durable writes.
	it('carries the caller-decided retryability', () => {
		assert.strictEqual(new TransactionCommitConflictTimeoutError('abandoned', true).retryable, true);
		assert.strictEqual(new TransactionCommitConflictTimeoutError('abandoned', false).retryable, false);
	});
});

describe('appendErrorContext', () => {
	it('appends to a writable message', () => {
		const err = new Error('base');
		appendErrorContext(err, ' while resolving record 1 for T');
		assert.strictEqual(err.message, 'base while resolving record 1 for T');
	});

	// What `fetch` rejects with when an AbortSignal.timeout fires: `message` is a getter-only
	// accessor on the prototype, so a plain assignment throws under strict mode.
	it('appends to a DOMException without throwing', () => {
		const err = new DOMException('aborted', 'TimeoutError');
		appendErrorContext(err, ' while resolving record 1 for T');
		assert.strictEqual(err.message, 'aborted while resolving record 1 for T');
		assert.strictEqual(err.name, 'TimeoutError');
	});

	it('leaves a frozen error intact rather than throwing', () => {
		const err = Object.freeze(new Error('frozen'));
		appendErrorContext(err, ' extra');
		assert.strictEqual(err.message, 'frozen');
	});

	it('survives an error whose message getter throws', () => {
		const err = Object.defineProperty(new Error('x'), 'message', {
			get() {
				throw new Error('hostile');
			},
			configurable: true,
		});
		assert.doesNotThrow(() => appendErrorContext(err, ' extra'));
	});

	it('ignores values that carry no message', () => {
		assert.doesNotThrow(() => appendErrorContext(undefined, ' extra'));
		assert.doesNotThrow(() => appendErrorContext('a string', ' extra'));
		assert.doesNotThrow(() => appendErrorContext({}, ' extra'));
	});
});
>>>>>>> 73c3bb3bc (Settle the source-fill promise when an error's message cannot be assigned)
