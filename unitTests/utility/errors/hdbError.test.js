const assert = require('assert');
const { IndexRebuildingError, ServerError } = require('#src/utility/errors/hdbError');

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
