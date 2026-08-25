const assert = require('node:assert');
const {
	PartialReadRetry,
	warnPartialReadGaveUp,
	isPartialReadWarned,
	clearPartialReadWarning,
} = require('#src/utility/watcherFallback');
const { waitFor } = require('../waitFor');

// The retry is a timer, so "it fired" is a condition to wait for; "it fired only once" is a
// non-event, which is the one case AGENTS.md reserves a fixed settle for.
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('PartialReadRetry', () => {
	it('re-reads once for a burst of unusable reads, not once per event', async () => {
		const retry = new PartialReadRetry('/nonexistent/config.yaml');
		let rereads = 0;

		assert.strictEqual(
			retry.schedule(() => rereads++),
			true
		);
		assert.strictEqual(
			retry.schedule(() => rereads++),
			true,
			'a second event joins the armed re-read'
		);

		await waitFor(() => rereads > 0, { message: 'the re-read never fired' });
		await settle();
		assert.strictEqual(rereads, 1);
	});

	it('cancels an armed re-read once a usable read arrives, so it cannot replay', async () => {
		const retry = new PartialReadRetry('/nonexistent/config.yaml');
		let rereads = 0;

		retry.schedule(() => rereads++);
		retry.settled();

		await settle();
		assert.strictEqual(rereads, 0);
	});

	it('reports exhaustion so the caller can fall back to its own error handling', async () => {
		const retry = new PartialReadRetry('/nonexistent/config.yaml');
		let rereads = 0;
		// Re-arm only after each timer has actually fired, so this counts budget rather than
		// racing the timer that is still armed (schedule() reports true for both).
		for (let attempt = 1; retry.schedule(() => rereads++); attempt++) {
			assert.ok(attempt <= 50, 'the budget must be bounded');
			await waitFor(() => rereads === attempt, { message: `re-read ${attempt} never fired` });
		}

		assert.ok(rereads > 0, 'the budget must allow at least one re-read');
		assert.strictEqual(
			retry.schedule(() => rereads++),
			false
		);

		// A usable read restores the budget for the next incident.
		retry.settled();
		assert.strictEqual(
			retry.schedule(() => rereads++),
			true
		);
	});

	it('re-arms the give-up warning once the file recovers', async () => {
		const retry = new PartialReadRetry('/nonexistent/recovering.yaml');
		// The warning is throttled per file so one bad config cannot produce one line per scope,
		// but a file that recovers and later breaks again is a new incident.
		warnPartialReadGaveUp('/nonexistent/recovering.yaml');
		assert.strictEqual(isPartialReadWarned('/nonexistent/recovering.yaml'), true);

		retry.settled();
		assert.strictEqual(isPartialReadWarned('/nonexistent/recovering.yaml'), false);
	});

	it('keeps the report standing when it gives up, and withdraws it only on recovery', async () => {
		// The gate is shared per file, so treating a give-up like a recovery would let each of the
		// N scopes watching one root config report the same file in turn.
		const path = '/nonexistent/shared.yaml';
		clearPartialReadWarning(path);
		const retry = new PartialReadRetry(path);

		assert.strictEqual(retry.gaveUp(), true, 'the first give-up is the one that reports');
		assert.strictEqual(
			new PartialReadRetry(path).gaveUp(),
			false,
			'another scope giving up on the same file must be suppressed, not reported again'
		);

		retry.settled();
		assert.strictEqual(isPartialReadWarned(path), false, 'a usable read is what withdraws the report');
		assert.strictEqual(new PartialReadRetry(path).gaveUp(), true, 'so the next incident reports again');
	});

	it('stops re-reading after close', async () => {
		const retry = new PartialReadRetry('/nonexistent/config.yaml');
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
