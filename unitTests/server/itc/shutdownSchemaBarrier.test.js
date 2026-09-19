'use strict';

const assert = require('node:assert');
const { assertSchemaEventSafeDuringWorkerShutdown } = require('#js/server/itc/serverHandlers');
const { PREPARE_DATABASE_DROP_OPERATION } = require('#src/utility/signalling');

describe('schema barriers during worker shutdown', function () {
	let previousStorageEngine;

	beforeEach(function () {
		previousStorageEngine = process.env.HARPER_STORAGE_ENGINE;
	});

	afterEach(function () {
		if (previousStorageEngine === undefined) delete process.env.HARPER_STORAGE_ENGINE;
		else process.env.HARPER_STORAGE_ENGINE = previousStorageEngine;
	});

	it('rejects an LMDB drop preparation instead of acknowledging unclosed handles', function () {
		process.env.HARPER_STORAGE_ENGINE = 'lmdb';
		assert.throws(
			() =>
				assertSchemaEventSafeDuringWorkerShutdown({
					operation: PREPARE_DATABASE_DROP_OPERATION,
					schema: 'catalog',
				}),
			(error) => error.code === 'ERR_LMDB_DROP_DURING_WORKER_SHUTDOWN'
		);
	});

	it('allows RocksDB closure and unrelated schema events to use the terminal close barrier', function () {
		process.env.HARPER_STORAGE_ENGINE = 'rocksdb';
		assert.doesNotThrow(() =>
			assertSchemaEventSafeDuringWorkerShutdown({
				operation: PREPARE_DATABASE_DROP_OPERATION,
				schema: 'catalog',
			})
		);
		process.env.HARPER_STORAGE_ENGINE = 'lmdb';
		assert.doesNotThrow(() =>
			assertSchemaEventSafeDuringWorkerShutdown({ operation: 'schema-change', schema: 'catalog' })
		);
	});
});
