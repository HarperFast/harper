'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createWorkerReadyPromise } = require('#src/server/threads/socketRouter');

describe('socketRouter createWorkerReadyPromise', () => {
	it('resolves when the worker posts child_started', async () => {
		const worker = new EventEmitter();
		const ready = createWorkerReadyPromise(worker, 0);
		worker.emit('message', { type: 'child_started' });
		assert.strictEqual(await ready, worker);
	});

	it('rejects if the worker exits before posting child_started', async () => {
		const worker = new EventEmitter();
		const ready = createWorkerReadyPromise(worker, 2);
		worker.emit('exit', 1);
		await assert.rejects(ready, /Worker \(index 2\) exited with code 1 before reporting ready/);
	});

	it('rejects on a worker error', async () => {
		const worker = new EventEmitter();
		const ready = createWorkerReadyPromise(worker, 0);
		// createWorkerReadyPromise attaches `reject` directly as the 'error' listener; EventEmitter
		// requires an 'error' listener to exist before emit('error', ...) or it throws synchronously.
		ready.catch(() => {});
		const error = new Error('boom');
		worker.emit('error', error);
		await assert.rejects(ready, error);
	});

	it('ignores an exit after child_started already resolved it', async () => {
		const worker = new EventEmitter();
		const ready = createWorkerReadyPromise(worker, 0);
		worker.emit('message', { type: 'child_started' });
		await ready;
		assert.doesNotThrow(() => worker.emit('exit', 0));
	});
});
