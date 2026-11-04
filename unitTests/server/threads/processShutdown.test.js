'use strict';

const assert = require('node:assert');
const { createTerminationHandler } = require('#src/server/threads/processShutdown');
const { waitFor } = require('../../waitFor.js');

describe('createTerminationHandler', () => {
	function handlerFor({ timeoutMs = 60_000, shutdown }) {
		const exits = [];
		const deadlines = [];
		const onSignal = createTerminationHandler({
			getTimeoutMs: () => timeoutMs,
			shutdown: (exitDeadline) => {
				deadlines.push(exitDeadline);
				return shutdown();
			},
			exit: () => exits.push(Date.now()),
		});
		return { onSignal, exits, deadlines };
	}

	it('exits once the shutdown settles, with the deadline it was given', async () => {
		let finish;
		const { onSignal, exits, deadlines } = handlerFor({
			shutdown: () => new Promise((resolve) => (finish = resolve)),
		});
		const before = Date.now();
		onSignal('SIGTERM');
		await waitFor(() => finish);
		assert.equal(exits.length, 0);
		assert.ok(deadlines[0] >= before + 60_000 && deadlines[0] <= Date.now() + 60_000);
		finish();
		await waitFor(() => exits.length > 0);
		assert.equal(exits.length, 1);
	});

	it('exits immediately on a second signal, and only once', async () => {
		let finish;
		const { onSignal, exits } = handlerFor({ shutdown: () => new Promise((resolve) => (finish = resolve)) });
		onSignal('SIGTERM');
		await waitFor(() => finish);
		onSignal('SIGINT');
		assert.equal(exits.length, 1);
		onSignal('SIGQUIT');
		finish();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(exits.length, 1);
	});

	it('exits at the timeout when the shutdown never settles', async () => {
		const { onSignal, exits } = handlerFor({ timeoutMs: 100, shutdown: () => new Promise(() => {}) });
		const start = Date.now();
		onSignal('SIGTERM');
		await waitFor(() => exits.length > 0, { timeout: 5000 });
		assert.ok(exits[0] - start >= 90, `exited after ${exits[0] - start} ms`);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(exits.length, 1);
	});

	it('still exits when the shutdown rejects or throws', async () => {
		const rejecting = handlerFor({ shutdown: () => Promise.reject(new Error('shutdown failed')) });
		rejecting.onSignal('SIGTERM');
		await waitFor(() => rejecting.exits.length > 0);
		const throwing = handlerFor({
			shutdown: () => {
				throw new Error('shutdown threw');
			},
		});
		throwing.onSignal('SIGTERM');
		await waitFor(() => throwing.exits.length > 0);
	});

	it('exits at once without a shutdown when the timeout is 0', () => {
		let shutdowns = 0;
		const { onSignal, exits } = handlerFor({ timeoutMs: 0, shutdown: () => shutdowns++ });
		onSignal('SIGTERM');
		assert.equal(exits.length, 1);
		assert.equal(shutdowns, 0);
	});
});
