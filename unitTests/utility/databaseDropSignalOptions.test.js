'use strict';

const assert = require('node:assert');
const { DATABASE_DROP_ACKNOWLEDGEMENT_TIMEOUT_MS, databaseDropSignalOptions } = require('#src/utility/signalling');

describe('database drop signalling options', function () {
	it('pins the destructive timeout, peer scope, and engine-specific close confirmation', function () {
		assert.deepStrictEqual(databaseDropSignalOptions(true), {
			acceptWorkerDatabaseClose: true,
			acknowledgementTimeoutMs: DATABASE_DROP_ACKNOWLEDGEMENT_TIMEOUT_MS,
			includeJobWorkers: true,
			mainFirst: true,
			rejectOnError: true,
		});
		assert.strictEqual(databaseDropSignalOptions(false).acceptWorkerDatabaseClose, false);
	});
});
