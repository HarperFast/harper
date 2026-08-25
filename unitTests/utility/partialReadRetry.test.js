const assert = require('node:assert');
const { PartialReadRetry } = require('#src/utility/watcherFallback');

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe('PartialReadRetry', () => {
	it('re-reads once per unusable read, not once per event', async () => {
		const retry = new PartialReadRetry();
		let rereads = 0;
		const reread = () => rereads++;

		assert.strictEqual(retry.schedule(reread), true);
		assert.strictEqual(retry.schedule(reread), true, 'a second event must join the armed re-read');
		await settle();

		assert.strictEqual(rereads, 1);
	});

	it('cancels an armed re-read once a usable read arrives, so it cannot replay', async () => {
		const retry = new PartialReadRetry();
		let rereads = 0;

		retry.schedule(() => rereads++);
		retry.settled();
		await settle();

		assert.strictEqual(rereads, 0);
	});

	it('reports exhaustion so the caller can fall back to its own error handling', async () => {
		const retry = new PartialReadRetry();
		let scheduled = 0;
		while (retry.schedule(() => {})) {
			scheduled++;
			await settle(30);
			assert.ok(scheduled < 50, 'the budget must be bounded');
		}
		assert.strictEqual(
			retry.schedule(() => {}),
			false
		);

		// A usable read restores the budget for the next incident.
		retry.settled();
		assert.strictEqual(
			retry.schedule(() => {}),
			true
		);
	});

	it('stops re-reading after close', async () => {
		const retry = new PartialReadRetry();
		let rereads = 0;

		retry.schedule(() => rereads++);
		retry.cancel();
		await settle();

		assert.strictEqual(rereads, 0);
		assert.strictEqual(
			retry.schedule(() => rereads++),
			false
		);
	});
});
