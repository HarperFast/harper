const assert = require('node:assert');
const {
	DEFAULT_FULL_TEXT_SEARCH_LIMITS,
	resolveFullTextSearchLimits,
} = require('#src/resources/indexes/fullTextSearchLimits');

describe('full-text search resource limits', () => {
	it('adopts new runtime budgets only in a fresh process and retains invalid snapshots', async function () {
		const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');
		if (!(await supportsPublishedFullTextBinding())) this.skip();
		const { execFileSync } = require('node:child_process');
		const fixture = require.resolve('./fixtures/fullTextRuntimeConfigurationProcess.cjs');
		const unmanaged = execFileSync(process.execPath, [fixture, '256', 'unmanaged'], {
			encoding: 'utf8',
			timeout: 15000,
		});
		assert.strictEqual(JSON.parse(unmanaged.trim().split('\n').at(-1)).unmanaged, 'ready');
		const early = execFileSync(process.execPath, [fixture, '256', 'early-worker'], {
			encoding: 'utf8',
			timeout: 15000,
		});
		const rejection = JSON.parse(early.trim().split('\n').at(-1)).unmanaged;
		assert.strictEqual(rejection.status, 500);
		assert.strictEqual(rejection.name, 'FullTextWorkerInitializationError');
		assert.strictEqual(rejection.retryable, false);
		assert.strictEqual(rejection.optionalRuntimeAvailable, false);
		assert.match(rejection.error, /Initialize Harper before creating application workers/);
		for (const value of [257, 258]) {
			const result = execFileSync(process.execPath, [fixture, String(value)], { encoding: 'utf8', timeout: 15000 });
			assert.strictEqual(JSON.parse(result.trim().split('\n').at(-1)).runtime.maxSearchThreads, value);
		}
		assert.throws(
			() => execFileSync(process.execPath, [fixture, '0'], { encoding: 'utf8', timeout: 15000 }),
			(error) => /positive safe integer/.test(error.stdout)
		);
	});

	it('resolves missing settings without changing the defaults', () => {
		assert.deepStrictEqual(resolveFullTextSearchLimits(undefined), DEFAULT_FULL_TEXT_SEARCH_LIMITS);
		assert(Object.isFrozen(DEFAULT_FULL_TEXT_SEARCH_LIMITS.runtime));
	});

	it('observes changed work limits when a live configuration object is reused', () => {
		const config = { maxRawHitsPerRequest: 10, requestBudgetMilliseconds: 100 };
		assert.strictEqual(resolveFullTextSearchLimits(config).maxRawHitsPerRequest, 10);
		config.maxRawHitsPerRequest = 20;
		config.requestBudgetMilliseconds = 200;
		const updated = resolveFullTextSearchLimits(config);
		assert.strictEqual(updated.maxRawHitsPerRequest, 20);
		assert.strictEqual(updated.requestBudgetMilliseconds, 200);
	});

	it('accepts integer strings and independently merges the native process budget', () => {
		const limits = resolveFullTextSearchLimits({
			requestBudgetMilliseconds: '7',
			runtime: { maxResidentIndexes: '256' },
		});
		assert.strictEqual(limits.requestBudgetMilliseconds, 7);
		assert.strictEqual(limits.maxRawHitsPerRequest, DEFAULT_FULL_TEXT_SEARCH_LIMITS.maxRawHitsPerRequest);
		assert.strictEqual(limits.runtime.maxResidentIndexes, 256);
		assert.strictEqual(limits.runtime.maxSearchThreads, DEFAULT_FULL_TEXT_SEARCH_LIMITS.runtime.maxSearchThreads);
	});

	it('rejects invalid full-text settings through the actual root configuration validator', () => {
		const { configValidator } = require('#src/validation/configValidator');
		const errors = (fullText) =>
			(
				configValidator(
					{ rootPath: require('node:path').resolve(__dirname, '../..'), storage: { writeAsync: false, fullText } },
					true
				).error?.details ?? []
			).filter(({ path }) => path[0] === 'storage' && path[1] === 'fullText');
		assert.deepStrictEqual(errors({ requestBudgetMilliseconds: 7, runtime: { maxResidentIndexes: 256 } }), []);
		for (const value of [
			{ requestBudgetMilliseconds: 0 },
			{ maxCursor: 4 },
			{ runtime: { maxSearchThreads: null } },
			{ requestBudgetMilliseconds: -1 },
		])
			assert(errors(value).length > 0, JSON.stringify(value));
	});

	it('reports a non-Error resolver failure through root configuration validation', () => {
		const { configValidator } = require('#src/validation/configValidator');
		const result = configValidator(
			{
				rootPath: require('node:path').resolve(__dirname, '../..'),
				storage: {
					writeAsync: false,
					fullText: {
						get runtime() {
							throw null;
						},
					},
				},
			},
			true
		);
		const detail = result.error?.details.find(({ path }) => path[0] === 'storage' && path[1] === 'fullText');
		assert(detail);
		assert.strictEqual(detail.message, 'null');
	});

	it('keeps the shipped YAML defaults and schema defaults consistent with the resolver', () => {
		const { readFileSync } = require('node:fs');
		const { resolve } = require('node:path');
		const { parse } = require('yaml');
		const root = resolve(__dirname, '../..');
		const yaml = parse(readFileSync(resolve(root, 'static/defaultConfig.yaml'), 'utf8'));
		assert.deepStrictEqual(yaml.storage.fullText, DEFAULT_FULL_TEXT_SEARCH_LIMITS);
		const schema = JSON.parse(readFileSync(resolve(root, 'config-root.schema.json'), 'utf8'));
		const policy = schema.properties.storage.properties.fullText;
		assert.strictEqual(policy.additionalProperties, false);
		assert.strictEqual(policy.properties.runtime.additionalProperties, false);
		for (const [name, value] of Object.entries(DEFAULT_FULL_TEXT_SEARCH_LIMITS)) {
			if (name === 'runtime' || name === 'query') {
				for (const [key, limit] of Object.entries(value))
					assert.strictEqual(policy.properties[name].properties[key].default, limit);
			} else assert.strictEqual(policy.properties[name].default, value);
		}
	});

	it('exposes every limit through the conventional configuration parameter map', () => {
		const { CONFIG_PARAM_MAP, CONFIG_PARAMS } = require('#src/utility/hdbTerms');
		const { flattenConfig } = require('#src/config/configUtils');
		const flattened = flattenConfig({ storage: { fullText: structuredClone(DEFAULT_FULL_TEXT_SEARCH_LIMITS) } });
		assert.deepStrictEqual(flattened.storage_fulltext_runtime, DEFAULT_FULL_TEXT_SEARCH_LIMITS.runtime);
		assert.strictEqual(CONFIG_PARAM_MAP.storage_fulltext_runtime, CONFIG_PARAMS.STORAGE_FULL_TEXT_RUNTIME);
		for (const [name, value] of Object.entries(DEFAULT_FULL_TEXT_SEARCH_LIMITS)) {
			const check = (path, expected) => {
				const parameter = `storage_fullText_${path}`;
				assert.strictEqual(CONFIG_PARAM_MAP[parameter.toLowerCase()], parameter);
				assert.strictEqual(flattened[parameter.toLowerCase()], expected);
			};
			if (name === 'runtime' || name === 'query')
				for (const [key, limit] of Object.entries(value)) check(`${name}_${key}`, limit);
			else check(name, value);
		}
	});

	it('rejects missing-shape, unknown and unbounded policy values', () => {
		for (const value of [null, [], true, 'settings', new Date(), Object.create({ requestBudgetMilliseconds: 7 })])
			assert.throws(() => resolveFullTextSearchLimits(value));
		for (const value of [null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', '1.5', '1e3', true]) {
			assert.throws(() => resolveFullTextSearchLimits({ requestBudgetMilliseconds: value }), /positive safe integer/);
			assert.throws(() => resolveFullTextSearchLimits({ maxRawHitsPerRequest: value }), /positive safe integer/);
			assert.throws(() => resolveFullTextSearchLimits({ maxResultsPerRequest: value }), /positive safe integer/);
			assert.throws(
				() => resolveFullTextSearchLimits({ runtime: { maxSearchThreads: value } }),
				/positive safe integer/
			);
		}
		assert.throws(() => resolveFullTextSearchLimits({ maxCursor: 4 }), /Unknown/);
		assert.throws(() => resolveFullTextSearchLimits({ runtime: { threads: 4 } }), /Unknown/);
		assert.throws(() => resolveFullTextSearchLimits({ constructor: 4 }), /Unknown/);
		assert.throws(() => resolveFullTextSearchLimits({ runtime: { maxResidentIndexes: 0x100000000 } }), /u32/);
	});
});

describe('full-text host query policy', () => {
	const {
		resolveFullTextQueryLimits,
		DEFAULT_FULL_TEXT_QUERY_LIMITS,
	} = require('#src/resources/indexes/fullTextSearchLimits');
	const {
		nativeFullTextQueryLimits,
		validateFullTextQueryRuntimeInfo,
	} = require('#src/resources/indexes/fullTextNativeBinding');
	it('captures reader policy across application workers and applies it to published native readers without changing writers', async function () {
		this.timeout(60000);
		const { supportsPublishedFullTextBinding } = require('./fullTextNativePlatform');
		if (!(await supportsPublishedFullTextBinding())) this.skip();
		const { execFileSync } = require('node:child_process');
		const { mkdtempSync, rmSync } = require('node:fs');
		const { join } = require('node:path');
		const { setupTestDBPath } = require('../testUtils');
		for (const policy of [
			{ maxQueryTerms: 1, maxQueryClauses: 1, maxFuzzyDistance: 0 },
			{ maxQueryTerms: 128, maxQueryClauses: 512, maxFuzzyDistance: 2 },
		]) {
			const root = mkdtempSync(join(setupTestDBPath(), 'native-policy-'));
			try {
				const output = execFileSync(
					process.execPath,
					[
						require.resolve('./fixtures/fullTextRuntimeConfigurationProcess.cjs'),
						'256',
						'policy',
						JSON.stringify(policy),
						root,
					],
					{ encoding: 'utf8', timeout: 30000 }
				);
				const result = JSON.parse(output.trim().split('\n').at(-1));
				assert.deepStrictEqual(result.policy, policy);
				assert.deepStrictEqual(result.inherited, policy);
				assert.strictEqual(result.overCode, 'E_INVALID_ARGUMENT');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});
	it('preserves defaults and strictly bounds independent host settings', () => {
		assert.deepStrictEqual(resolveFullTextQueryLimits(undefined), {
			maxQueryTerms: 64,
			maxQueryClauses: 256,
			maxFuzzyDistance: 1,
		});
		assert(Object.isFrozen(DEFAULT_FULL_TEXT_QUERY_LIMITS));
		assert.deepStrictEqual(
			resolveFullTextQueryLimits({ maxQueryTerms: '1024', maxQueryClauses: '4096', maxFuzzyDistance: '0' }),
			{ maxQueryTerms: 1024, maxQueryClauses: 4096, maxFuzzyDistance: 0 }
		);
		for (const [name, ceiling] of [
			['maxQueryTerms', 1024],
			['maxQueryClauses', 4096],
			['maxFuzzyDistance', 2],
		]) {
			for (const value of [null, -1, 1.5, NaN, Infinity, true, '', ceiling + 1])
				assert.throws(() => resolveFullTextQueryLimits({ [name]: value }), name + ':' + value);
		}
		assert.throws(() => resolveFullTextQueryLimits({ maxQueryTerms: 0 }));
		assert.throws(() => resolveFullTextQueryLimits({ unknown: 1 }), /Unknown/);
	});
	it('uses advertised native ceilings rather than accepting configured values blindly', async () => {
		const { FullTextNativeTestBinding } = require('./fullTextNativeTestBinding');
		const info = await new FullTextNativeTestBinding().runtimeInfo();
		assert.strictEqual(nativeFullTextQueryLimits(info, { maxQueryTerms: 128 }).maxQueryTerms, 128);
		assert.throws(
			() =>
				nativeFullTextQueryLimits(
					{ ...info, limits: { ...info.limits, maxConfiguredQueryTerms: 127 } },
					{ maxQueryTerms: 128 }
				),
			/native runtime ceiling/
		);
		for (const name of ['maxConfiguredQueryTerms', 'maxConfiguredQueryClauses'])
			for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, '1024'])
				assert.throws(
					() => validateFullTextQueryRuntimeInfo({ ...info, limits: { ...info.limits, [name]: value } }),
					/incompatible runtime capabilities/
				);
	});
});
