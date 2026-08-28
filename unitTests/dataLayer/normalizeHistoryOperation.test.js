'use strict';

// Lives here rather than mirroring the source under `harperBridge/`: every `test:unit:*` script
// excludes `unitTests/dataLayer/harperBridge/**`, so a test in the mirroring directory never runs.
const assert = require('node:assert');
const { normalizeHistoryOperation } = require('#src/dataLayer/harperBridge/bridgeUtility/normalizeHistoryOperation');

describe('normalizeHistoryOperation', function () {
	it('reports the recorded originating operation when there is one', function () {
		// The case that matters for catch-up: a recorded `put` must stay a `put`, or the replica gets
		// patched and keeps attributes the source removed.
		assert.strictEqual(normalizeHistoryOperation('put', 'put'), 'put');
		assert.strictEqual(normalizeHistoryOperation('upsert', 'put'), 'upsert');
		assert.strictEqual(normalizeHistoryOperation('insert', 'put'), 'insert');
		assert.strictEqual(normalizeHistoryOperation('update', 'patch'), 'update');
	});

	// The legacy fallback, and the reason this is a unit test at all: through the operations API every
	// write now records an originating operation, so an integration probe cannot reach this branch —
	// it would return at the line above and assert nothing about the fallback.
	it('normalizes a LEGACY physical put — one with no originating operation — to upsert', function () {
		assert.strictEqual(normalizeHistoryOperation(undefined, 'put'), 'upsert');
	});

	it('passes a legacy non-put physical type through unchanged', function () {
		// Only `put` is ambiguous. A physical `patch` or `delete` means what it says.
		assert.strictEqual(normalizeHistoryOperation(undefined, 'patch'), 'patch');
		assert.strictEqual(normalizeHistoryOperation(undefined, 'delete'), 'delete');
		assert.strictEqual(normalizeHistoryOperation(undefined, 'message'), 'message');
	});

	// `undefined` is the "not recorded" signal, so anything else — including falsy values — has to be
	// treated as a real recorded operation rather than falling through to the physical type.
	it('treats only undefined as absent', function () {
		assert.strictEqual(normalizeHistoryOperation('', 'put'), '');
		assert.strictEqual(normalizeHistoryOperation(null, 'put'), null);
	});
});
