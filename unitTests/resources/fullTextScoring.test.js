const assert = require('node:assert');
const {
	validateFullTextScoringOptions,
	validateFullTextScoringRuntime,
} = require('#src/resources/indexes/fullTextQueryProtocol');
const { validateFullTextRuntimeVersions } = require('#src/resources/indexes/fullTextNativeBinding');

describe('full-text scoring contract', () => {
	it('accepts float32-rounded boosts and rejects invalid numeric values', () => {
		for (const boost of [0, 0.25, 1, 100, 100.000001, Number.MIN_VALUE])
			validateFullTextScoringOptions({ boost }, 'any');
		for (const boost of [-0, -1, -Number.MIN_VALUE, 100.01, NaN, Infinity, -Infinity, '2', null])
			assert.throws(() => validateFullTextScoringOptions({ boost }, 'any'), /boost/);
	});

	it('rejects unsupported locations and malformed optional descriptors', () => {
		const leaf = { comparator: 'matches', value: 'widget' };
		validateFullTextScoringOptions({ should: [leaf] }, 'any');
		for (const condition of [
			{ boost: 1 },
			{ should: [leaf] },
			{ boost: 1, negated: true },
			{ boost: 1, conditions: [] },
		])
			assert.throws(() => validateFullTextScoringOptions(condition), /positive full-text/);
		for (const should of [
			[],
			null,
			leaf,
			[null],
			[{ ...leaf, attribute: 'other' }],
			[{ ...leaf, should: [leaf] }],
			[{ ...leaf, negated: true }],
			[{ ...leaf, comparator: 'not_matches' }],
			[{ ...leaf, value: '' }],
			[{ ...leaf, fuzzyDistance: 1 }],
		])
			assert.throws(
				() => validateFullTextScoringOptions({ should }, 'any'),
				(error) => error.statusCode === 400
			);
	});

	it('explicitly rejects scoring on old runtimes', () => {
		validateFullTextScoringRuntime(8);
		assert.throws(
			() => validateFullTextScoringRuntime(7),
			(error) => error.statusCode === 400 && /query API 8/.test(error.message)
		);
	});

	it('accepts only supported ABI and query API pairs', () => {
		const stable = { lifecycleApiVersion: 1, mutationBatchApiVersion: 5 };
		for (const [nativeAbiVersion, queryApiVersion] of [
			[13, 7],
			[14, 8],
		])
			validateFullTextRuntimeVersions({ ...stable, nativeAbiVersion, queryApiVersion });
		for (const [nativeAbiVersion, queryApiVersion] of [
			[13, 8],
			[14, 7],
			[15, 8],
			[12, 7],
		])
			assert.throws(
				() => validateFullTextRuntimeVersions({ ...stable, nativeAbiVersion, queryApiVersion }),
				/incompatible/
			);
		assert.throws(
			() =>
				validateFullTextRuntimeVersions({
					...stable,
					nativeAbiVersion: 14,
					queryApiVersion: 8,
					lifecycleApiVersion: 2,
				}),
			/incompatible/
		);
	});
});
