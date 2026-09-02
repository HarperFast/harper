const assert = require('assert');
const {
	IndexRebuildingError,
	ServerError,
	TransactionCommitConflictTimeoutError,
} = require('#src/utility/errors/hdbError');

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
