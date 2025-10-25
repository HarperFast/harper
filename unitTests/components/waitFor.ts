import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

export async function waitFor(condition, timeout = 1000, interval = 100) {
	let time = 0;
	while (!condition()) {
		await setTimeout(interval);
		if ((time += interval) > timeout) {
			assert.fail('Timeout waiting for condition');
		}
	}
}
