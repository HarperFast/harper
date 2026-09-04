'use strict';

const assert = require('node:assert');
const { setTimeout: delay } = require('node:timers/promises');
const { ConfigReadRetry } = require('#src/config/configReadRetry');
const { waitFor } = require('../waitFor');

const RETRY_BUDGET_MS = 3_100;
const INITIAL_DELAY_MS = 100;

describe('ConfigReadRetry', () => {
	it('arms a retry and reports that it did', async () => {
		const retry = new ConfigReadRetry();
		let fired = 0;

		assert.equal(
			retry.schedule(() => fired++),
			true
		);
		assert.equal(fired, 0, 'the retry must not run inline');

		await waitFor(() => fired === 1, { message: 'the armed retry never ran' });
		retry.cancel();
	});

	it('does not push the next attempt out when a burst of events arrives at once', async () => {
		const retry = new ConfigReadRetry();
		let fired = 0;

		// One atomic rename can deliver add + change + change within a millisecond; every one of
		// them enters the same failing read path. Advancing the backoff per call rather than per
		// elapsed millisecond would strand the caller at the maximum delay while the file is
		// already readable again.
		for (let i = 0; i < 8; i++) retry.schedule(() => fired++);

		await waitFor(() => fired > 0, { message: 'a burst must still arm a retry, and promptly' });
		// The burst armed one timer, not eight; nothing else can raise the count.
		await delay(INITIAL_DELAY_MS);
		assert.equal(fired, 1, 'a burst must arm exactly one retry');
		retry.cancel();
	});

	it('reports the budget spent instead of retrying forever', async () => {
		const retry = new ConfigReadRetry();
		const startedAt = performance.now();
		let scheduled = 0;

		while (retry.schedule(() => {})) {
			scheduled++;
			// Stand in for the timer so the ladder walks its whole budget without waiting on it.
			await delay(0);
			if (performance.now() - startedAt > RETRY_BUDGET_MS * 2) break;
		}

		assert.ok(scheduled > 1, `the ladder gave up after ${scheduled} attempts`);
		assert.ok(
			performance.now() - startedAt >= RETRY_BUDGET_MS * 0.9,
			'the ladder must be bounded by wall clock, not by how often it is called'
		);
		retry.cancel();
	});

	it('starts a fresh budget once the caller has been told the ladder is spent', async () => {
		const retry = new ConfigReadRetry();
		while (retry.schedule(() => {})) await delay(0);

		// Reporting the budget spent ends that ladder, so the next event — a later write, not this
		// burst — gets its own full budget rather than inheriting an exhausted one.
		const startedAt = performance.now();
		let scheduled = 0;
		while (retry.schedule(() => {})) {
			scheduled++;
			await delay(0);
			if (performance.now() - startedAt > RETRY_BUDGET_MS * 2) break;
		}

		assert.ok(scheduled > 1, `the second ladder gave up after ${scheduled} attempts`);
		assert.ok(performance.now() - startedAt >= RETRY_BUDGET_MS * 0.9, 'the second ladder must get a full budget');
		retry.cancel();
	});

	it('cancel leaves no timer behind', async () => {
		const retry = new ConfigReadRetry();
		let fired = 0;
		retry.schedule(() => fired++);
		retry.cancel();

		await delay(INITIAL_DELAY_MS * 3);
		assert.equal(fired, 0);
	});
});
