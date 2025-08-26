const assert = require('node:assert/strict');
const { setTimeout } = require('node:timers/promises');

async function waitFor(condition, timeout = 1000, interval = 100) {
	let time = 0;
	while (!condition()) {
		await setTimeout(interval);
		if ((time += interval) > timeout) {
			assert.fail('Timeout waiting for condition');
		}
	}
}

module.exports = { waitFor };
