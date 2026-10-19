const assert = require('node:assert');
const { randomBytes } = require('node:crypto');
const { FullTextContinuationToken } = require('#src/resources/indexes/fullTextContinuationToken');
const { ServerError } = require('#src/utility/errors/hdbError');

describe('full-text continuation tokens', () => {
	const key = randomBytes(32).toString('base64url');
	const lease = 'a'.repeat(32);
	const query = 'b'.repeat(64);
	const position = { boundary: 'native-boundary', batchSize: 113, consumed: 73 };

	it('routes across workers while keeping the boundary private to its owner', () => {
		const owner = new FullTextContinuationToken(key, 'process-1', 7, 10000);
		const peer = new FullTextContinuationToken(key, 'process-1', 8, 10000);
		const token = owner.seal(lease, query, position);
		assert.strictEqual(peer.route(token).owner, 7);
		assert.strictEqual(peer.route(token).lease, lease);
		assert.deepStrictEqual(owner.open(token, query), { lease, position });
		assert.throws(
			() => peer.open(token, query),
			(error) => error.statusCode === 410
		);
		assert.throws(
			() => owner.open(token, 'c'.repeat(64)),
			(error) => error.statusCode === 410
		);
		assert(!token.includes('native-boundary'));
	});

	it('rejects tampering, process restart and missing owner secrets before use', () => {
		const owner = new FullTextContinuationToken(key, 'process-1', 7, 10000);
		const token = owner.seal(lease, query, position);
		for (const value of [
			'',
			'x.y.z',
			token + 'x',
			'x'.repeat(16385),
			token.replace(/^./, token[0] === 'e' ? 'f' : 'e'),
		])
			assert.throws(
				() => owner.route(value),
				(error) => error.statusCode === 410
			);
		const restarted = new FullTextContinuationToken(key, 'process-2', 7, 10000);
		assert.throws(
			() => restarted.route(token),
			(error) => error.statusCode === 410
		);
		const replacement = new FullTextContinuationToken(key, 'process-1', 7, 10000);
		assert.throws(
			() => replacement.open(token, query),
			(error) => error.statusCode === 410
		);
	});

	it('preserves immutable replay boundaries and enforces framing bounds', () => {
		const owner = new FullTextContinuationToken(key, 'process-1', 7, 10000);
		const token = owner.seal(lease, query, position);
		owner.seal(lease, query, { batchSize: 17, consumed: 0 });
		assert.deepStrictEqual(owner.open(token, query).position, position);
		const maximum = { boundary: 'x'.repeat(6000), batchSize: 10000, consumed: 9999 };
		assert.deepStrictEqual(owner.open(owner.seal(lease, query, maximum), query).position, maximum);
		for (const bad of [
			{ batchSize: 0, consumed: 0 },
			{ ...position, consumed: 114 },
			{ ...maximum, boundary: 'x'.repeat(16385) },
		])
			assert.throws(() => owner.seal(lease, query, bad), /Invalid/);
	});

	it('reports a server-generated token overflow without including its boundary', () => {
		const owner = new FullTextContinuationToken(key, 'process-1', 7, 10000);
		assert.throws(
			() => owner.seal(lease, query, { boundary: 'x'.repeat(12300), batchSize: 1, consumed: 0 }),
			(error) => error instanceof ServerError && error.statusCode === 500 && !error.message.includes('xxxxx')
		);
	});
});
