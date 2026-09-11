import assert from 'node:assert';
import test from 'node:test';

import { PendingRequests } from './PendingRequests.mts';

test('drains successful requests', async () => {
	const requests = new PendingRequests();
	requests.add(Promise.resolve());

	await requests.drain('test workload');

	assert.strictEqual(requests.failed, false);
	assert.strictEqual(requests.size, 0);
});

test('retains write failures after settled requests leave the pending set', async () => {
	const failure = new Error('request failed');
	const requests = new PendingRequests();
	requests.add(Promise.reject(failure));

	await requests.waitForOne();
	assert.strictEqual(requests.failed, true);
	assert.strictEqual(requests.size, 0);
	await assert.rejects(requests.drain('test workload'), (error) => {
		assert(error instanceof AggregateError);
		assert.deepStrictEqual(error.errors, [failure]);
		assert.match(error.message, /test workload failed for 1 request/);
		return true;
	});
});

test('retains a zero-hit search assertion after the search leaves the pending set', async () => {
	const requests = new PendingRequests();
	requests.add(
		Promise.resolve().then(() => {
			assert.fail('full-text query returned no hits');
		})
	);

	await requests.waitForOne();
	await assert.rejects(requests.drain('concurrent full-text searches'), (error) => {
		assert(error instanceof AggregateError);
		assert.strictEqual(error.errors.length, 1);
		assert.match(error.errors[0].message, /full-text query returned no hits/);
		return true;
	});
});
