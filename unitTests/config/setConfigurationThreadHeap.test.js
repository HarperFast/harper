'use strict';

const assert = require('node:assert');

const { setConfiguration } = require('#src/config/configUtils');
const { MIN_THREAD_HEAP_MEMORY_MB } = require('#src/utility/hdbTerms');
const { server } = require('#src/server/Server');

describe('set_configuration threads.maxHeapMemory rejection', () => {
	const EXPECTED = new RegExp(
		`'threads\\.maxHeapMemory' must be greater than or equal to ${MIN_THREAD_HEAP_MEMORY_MB}`
	);
	let fanOutCalls;
	let originalReplicateOperation;

	// Recording the fan-out is what makes these ordering assertions rather than error assertions:
	// moving the guard below the local write would still throw, but would already have persisted
	// the value and pushed it to every peer.
	beforeEach(() => {
		fanOutCalls = 0;
		originalReplicateOperation = server.replication?.replicateOperation;
		if (server.replication)
			server.replication.replicateOperation = async () => {
				fanOutCalls++;
				return { message: '' };
			};
	});

	afterEach(() => {
		if (server.replication) server.replication.replicateOperation = originalReplicateOperation;
	});

	it('rejects a below-minimum value with a 400', async () => {
		await assert.rejects(setConfiguration({ operation: 'set_configuration', threads_maxHeapMemory: 1 }), (error) => {
			assert.match(error.message, EXPECTED);
			assert.strictEqual(error.statusCode ?? error.status, 400);
			return true;
		});
	});

	it('rejects the numeric-string spelling after casting', async () => {
		await assert.rejects(setConfiguration({ operation: 'set_configuration', threads_maxHeapMemory: '8' }), EXPECTED);
	});

	it('rejects zero, which V8 normalizes to an unstartable limit rather than treating as unset', async () => {
		await assert.rejects(setConfiguration({ operation: 'set_configuration', threads_maxHeapMemory: 0 }), EXPECTED);
	});

	it('rejects the whole-section spelling, which reaches the same config key', async () => {
		await assert.rejects(
			setConfiguration({ operation: 'set_configuration', threads: { count: 4, maxHeapMemory: 1 } }),
			EXPECTED
		);
	});

	it('rejects the section spelling with a lower-cased nested key', async () => {
		await assert.rejects(setConfiguration({ operation: 'set_configuration', threads: { maxheapmemory: 8 } }), EXPECTED);
	});

	it('rejects the section spelling sent as a JSON string', async () => {
		await assert.rejects(
			setConfiguration({ operation: 'set_configuration', threads: '{"maxHeapMemory":8}' }),
			EXPECTED
		);
	});

	it('rejects before fan-out, so no peer ever receives the value', async () => {
		await assert.rejects(
			setConfiguration({ operation: 'set_configuration', threads_maxHeapMemory: 1, replicated: true }),
			EXPECTED
		);
		assert.strictEqual(fanOutCalls, 0);
	});

	it('rejects the replicated whole-section spelling before fan-out too', async () => {
		await assert.rejects(
			setConfiguration({ operation: 'set_configuration', threads: { maxHeapMemory: 0 }, replicated: true }),
			EXPECTED
		);
		assert.strictEqual(fanOutCalls, 0);
	});
});
