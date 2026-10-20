require('../testUtils');
const assert = require('node:assert');
const { FullTextContinuationPage } = require('#src/resources/indexes/fullTextContinuationPage');
const { DEFAULT_FULL_TEXT_SEARCH_LIMITS } = require('#src/resources/indexes/fullTextSearchLimits');

const target = { continuation: true, limit: 3 };
const hash = (identity) => new FullTextContinuationPage(target, identity).queryHash;

describe('full-text visible continuation pages', () => {
	it('accepts a zero REST offset and rejects skipping within a continuation', () => {
		const { RequestTarget } = require('#src/resources/RequestTarget');
		const query = new RequestTarget('/?limit(0,25)&continuation()');
		assert.strictEqual(query.offset, 0);
		assert.strictEqual(query.limit, 25);
		assert.doesNotThrow(() => new FullTextContinuationPage(query, {}));
		assert.throws(
			() => new FullTextContinuationPage(new RequestTarget('/?limit(1,25)&continuation()'), {}),
			(error) => error.statusCode === 400
		);
	});

	it('binds meaningful typed values while ignoring object property insertion order', () => {
		assert.strictEqual(hash({ query: 'widget', select: ['id'] }), hash({ select: ['id'], query: 'widget' }));
		const values = [
			null,
			undefined,
			0,
			0n,
			9007199254740993n,
			-0,
			'0',
			false,
			new Date('2026-01-01'),
			'2026-01-01T00:00:00.000Z',
			Buffer.from('a'),
			'YQ',
			['a'],
			{ 0: 'a' },
		];
		assert.strictEqual(new Set(values.map(hash)).size, values.length);
		const shared = { query: 'widget' };
		assert.doesNotThrow(() => hash([shared, shared]));
		const circular = {};
		circular.self = circular;
		for (const invalid of [circular, NaN, Infinity, new Date(NaN), () => true])
			assert.throws(
				() => hash(invalid),
				(error) => error.statusCode === 400
			);
	});

	it('detects requested continuation options without treating false close as a request', () => {
		const { hasFullTextContinuationOptions } = require('#src/resources/indexes/fullTextQueryProtocol');
		for (const value of [undefined, false, true, null, 0, '', 'token']) {
			assert.strictEqual(hasFullTextContinuationOptions({ continuation: value }), value !== undefined);
			assert.strictEqual(
				hasFullTextContinuationOptions({ closeContinuation: value }),
				value !== undefined && value !== false
			);
		}
		assert.strictEqual(hasFullTextContinuationOptions(undefined), false);
	});

	it('treats false closeContinuation as a normal page request', () => {
		for (const continuation of [true, 'opaque']) {
			const page = new FullTextContinuationPage({ ...target, continuation, closeContinuation: false }, {});
			assert.strictEqual(page.close, false);
		}
		for (const closeContinuation of [0, '', 'false', null])
			assert.throws(
				() => new FullTextContinuationPage({ ...target, continuation: 'opaque', closeContinuation }, {}),
				(error) => error.statusCode === 400
			);
	});
	it('binds named properties and missing elements on array-form conditions', () => {
		const condition = Object.assign(['catalogSearch', 'widget'], { comparator: 'matches' });
		assert.strictEqual(hash(condition), hash(Object.assign(['catalogSearch', 'widget'], { comparator: 'matches' })));
		assert.notStrictEqual(
			hash(condition),
			hash(Object.assign(['catalogSearch', 'widget'], { comparator: 'matches_prefix' }))
		);
		assert.notStrictEqual(hash(Array(1)), hash([undefined]));
		assert.notStrictEqual(hash([]), hash(Array(1)));
	});
	it('requires bounded pages and rejects incompatible modes', () => {
		for (const change of [
			{ limit: 0 },
			{ limit: Infinity },
			{ limit: DEFAULT_FULL_TEXT_SEARCH_LIMITS.maxPageSize + 1 },
			{ offset: 1 },
			{ count: 'exact' },
			{ sync: true },
			{ continuation: false },
			{ closeContinuation: true },
		])
			assert.throws(
				() => new FullTextContinuationPage({ ...target, ...change }, {}),
				(error) => error.statusCode === 400
			);
	});
	it('binds resolved settings rather than their configuration spelling', () => {
		const env = require('#src/utility/environment/environmentManager');
		const { CONFIG_PARAMS } = require('#src/utility/hdbTerms');
		const previous = env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT);
		try {
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { maxPageSize: 37 });
			const number = hash({ query: 'widget' });
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { maxPageSize: '37' });
			assert.strictEqual(hash({ query: 'widget' }), number);
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, { maxPageSize: 38 });
			assert.notStrictEqual(hash({ query: 'widget' }), number);
		} finally {
			env.setProperty(CONFIG_PARAMS.STORAGE_FULL_TEXT, previous);
		}
	});

	it('keeps page metadata outside the JSON array body', () => {
		const page = new FullTextContinuationPage(target, {});
		page.records.push({ id: 'a' });
		page.continuation = 'opaque';
		page.expiresAt = 1234;
		const result = page.result();
		assert.strictEqual(result.continuation, 'opaque');
		assert.strictEqual(result.complete, false);
		assert.strictEqual(result.expiresAt, 1234);
		assert.strictEqual(JSON.stringify(result), '[{"id":"a"}]');
	});
});
