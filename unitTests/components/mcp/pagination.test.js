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

	it('returns null when the decoded offset is missing or out of range', () => {
		const enc = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
		assert.equal(decodeCursor(enc({})), null); // missing offset
		assert.equal(decodeCursor(enc({ offset: -1 })), null); // negative
		assert.equal(decodeCursor(enc({ offset: 1.5 })), null); // non-integer
		assert.equal(decodeCursor(enc({ offset: 'x' })), null); // non-number
	});
});
