const assert = require('node:assert');

const testUtils = require('../testUtils.js');
testUtils.preTestPrep();

const { toCloseReason } = require('#src/server/serverHelpers/webSocketCloseReason');

// `ws` throws a RangeError past 123 bytes, from inside a rejection handler where it would surface
// as an unhandled rejection (harper#2703).
const LIMIT = 123;

describe('toCloseReason', () => {
	it('passes a short reason through unchanged', () => {
		assert.strictEqual(toCloseReason('Login failed'), 'Login failed');
	});

	it('passes a reason of exactly the limit through unchanged', () => {
		const exact = 'a'.repeat(LIMIT);
		assert.strictEqual(toCloseReason(exact), exact);
		assert.strictEqual(Buffer.byteLength(toCloseReason(exact), 'utf8'), LIMIT);
	});

	it('truncates a longer reason to the limit', () => {
		const long = 'a'.repeat(400);

		const reason = toCloseReason(long);

		assert.strictEqual(Buffer.byteLength(reason, 'utf8'), LIMIT);
		assert.ok(long.startsWith(reason));
	});

	it('never splits a multi-byte character', () => {
		// 'é' is 2 bytes, so a byte-wise cut at 123 would land mid-character
		const reason = toCloseReason('é'.repeat(200));

		assert.ok(Buffer.byteLength(reason, 'utf8') <= LIMIT);
		assert.ok(!reason.includes('�'), 'a replacement character means a code point was split');
		assert.strictEqual(reason, 'é'.repeat(61));
	});

	it('never splits a surrogate pair', () => {
		// each emoji is 4 bytes; 30 of them is 120, so the 31st must be dropped whole
		const reason = toCloseReason('😀'.repeat(50));

		assert.ok(Buffer.byteLength(reason, 'utf8') <= LIMIT);
		assert.strictEqual(reason, '😀'.repeat(30));
		assert.ok(!reason.includes('�'));
	});

	it('handles an absent or empty reason', () => {
		assert.strictEqual(toCloseReason(undefined), '');
		assert.strictEqual(toCloseReason(''), '');
	});

	it('bounds a very long message without scanning all of it', () => {
		const huge = 'x'.repeat(10_000_000);

		const reason = toCloseReason(huge);

		assert.strictEqual(Buffer.byteLength(reason, 'utf8'), LIMIT);
	});

	it('bounds a message an override controls, which is the reason this exists', () => {
		const overrideMessage = `SSO session expired: ${'detail '.repeat(100)}`;

		assert.ok(Buffer.byteLength(overrideMessage, 'utf8') > LIMIT, 'the fixture must exceed the limit');
		assert.ok(Buffer.byteLength(toCloseReason(overrideMessage), 'utf8') <= LIMIT);
	});
});
