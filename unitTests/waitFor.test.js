'use strict';

const assert = require('node:assert');
const { waitFor } = require('./waitFor.js');

describe('waitFor', () => {
	const realDateNow = Date.now;
	// afterEach, not finally: if waitFor regresses to Date.now, the mocha timeout abandons the test
	// with its promise unsettled, so a finally would leave the clock frozen for later suites
	afterEach(() => {
		Date.now = realDateNow;
	});

	it('times out with its message while Date.now is frozen', async function () {
		// backstop: a deadline on the frozen clock never arrives, and .mocharc.json sets no timeout
		this.timeout(5000);
		const frozenNow = realDateNow();
		Date.now = () => frozenNow;
		await assert.rejects(
			waitFor(() => false, { timeout: 50, message: 'never true' }),
			{ message: 'never true' }
		);
	});

	it('resolves with the truthy condition result', async () => {
		let polls = 0;
		assert.strictEqual(await waitFor(() => ++polls >= 3 && 'done', 1000, 1), 'done');
	});
});
