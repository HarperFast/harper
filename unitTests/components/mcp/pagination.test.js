const assert = require('node:assert/strict');
const { encodeCursor, decodeCursor } = require('#src/components/mcp/pagination');

describe('components/mcp/pagination', () => {
	it('round-trips an offset through encode/decode', () => {
		for (const offset of [0, 1, 42, 1000]) {
			assert.equal(decodeCursor(encodeCursor(offset)), offset);
		}
	});

	it('produces an opaque base64url string (no JSON punctuation)', () => {
		const cursor = encodeCursor(5);
		assert.doesNotMatch(cursor, /[{}":]/);
	});

	it('returns null for a non-base64url / non-JSON cursor (#1317 S2)', () => {
		assert.equal(decodeCursor('not-a-real-cursor'), null);
		assert.equal(decodeCursor('$$nonsense$$'), null);
		assert.equal(decodeCursor(''), null);
	});

	it('rejects a tampered cursor with junk appended (non-canonical base64url)', () => {
		// Node's base64url decoder silently ignores the trailing `!`, so without a
		// canonical-form check this would decode to a valid offset (Codex finding).
		const valid = encodeCursor(5);
		assert.equal(decodeCursor(valid), 5);
		assert.equal(decodeCursor(`${valid}!`), null);
	});

	it('returns null for an over-long cursor before parsing (resource-exhaustion guard)', () => {
		assert.equal(decodeCursor('A'.repeat(513)), null);
		// A normal cursor is well under the cap and still decodes.
		assert.equal(decodeCursor(encodeCursor(7)), 7);
	});

	it('returns null when the decoded offset is missing or out of range', () => {
		const enc = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
		assert.equal(decodeCursor(enc({})), null); // missing offset
		assert.equal(decodeCursor(enc({ offset: -1 })), null); // negative
		assert.equal(decodeCursor(enc({ offset: 1.5 })), null); // non-integer
		assert.equal(decodeCursor(enc({ offset: 'x' })), null); // non-number
	});
});
