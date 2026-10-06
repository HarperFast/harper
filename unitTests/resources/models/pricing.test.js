'use strict';

const assert = require('node:assert');
// Prime the module graph in the same order the other models unit tests do.
require('#src/resources/databases');
const {
	setGenerative,
	defineBackend,
	clearRegistry,
	getBackend,
	getBackendPricing,
	setBackendPricing,
} = require('#src/resources/models/backendRegistry');
const { setFallbackGroup, clearRouting } = require('#src/resources/models/routing');
const { bootstrapModels, applyModelsConfig, resetModelsProjection } = require('#src/resources/models/bootstrap');
const { Models } = require('#src/resources/models/Models');

const PRICING = { inputPerMtok: 3, outputPerMtok: 15 };
const writer = () => ({ write: () => {} });
const completedWith = (usage, output = { content: 'ok', finishReason: 'stop' }) => ({
	status: 'completed',
	output,
	usage,
});

function backendReturning(name, usage, output) {
	return defineBackend({ name, generate: async () => completedWith(usage, output) });
}

describe('Models.generate pricing', () => {
	beforeEach(() => {
		clearRegistry();
		clearRouting();
	});
	afterEach(() => {
		clearRegistry();
		clearRouting();
	});

	it("prices a call from both token counts at the entry's rates", async () => {
		const backend = backendReturning('priced', { promptTokens: 1_000_000, completionTokens: 200_000 });
		setGenerative('default', backend);
		setBackendPricing(backend, PRICING);
		const result = await new Models(writer()).generate('hi');
		assert.strictEqual(result.costUsd, 3 + 3);
		assert.deepStrictEqual(result.usage, { promptTokens: 1_000_000, completionTokens: 200_000 });
	});

	it('leaves an unpriced call without costUsd', async () => {
		setGenerative('default', backendReturning('unpriced', { promptTokens: 10, completionTokens: 5 }));
		const result = await new Models(writer()).generate('hi');
		assert.strictEqual('costUsd' in result, false);
		assert.deepStrictEqual(result.usage, { promptTokens: 10, completionTokens: 5 });
	});

	for (const [label, usage] of [
		['an empty usage object', {}],
		['a missing completion count', { promptTokens: 10 }],
		['a non-finite count', { promptTokens: Number.NaN, completionTokens: 5 }],
		['a negative count', { promptTokens: -1, completionTokens: 5 }],
		['no usage at all', undefined],
	]) {
		it(`does not price ${label}, rather than under-price it`, async () => {
			const backend = backendReturning('partial', usage);
			setGenerative('default', backend);
			setBackendPricing(backend, PRICING);
			const result = await new Models(writer()).generate('hi');
			assert.strictEqual(result.costUsd, undefined);
		});
	}

	it('prices zero tokens at zero, not as unmeasured', async () => {
		const backend = backendReturning('zero', { promptTokens: 0, completionTokens: 0 });
		setGenerative('default', backend);
		setBackendPricing(backend, PRICING);
		assert.strictEqual((await new Models(writer()).generate('hi')).costUsd, 0);
	});

	it('drops usage and costUsd a backend put on its own output', async () => {
		setGenerative(
			'default',
			backendReturning('smuggler', undefined, {
				content: 'ok',
				finishReason: 'stop',
				usage: { promptTokens: 1, completionTokens: 1 },
				costUsd: 0,
			})
		);
		const result = await new Models(writer()).generate('hi');
		assert.strictEqual('usage' in result, false);
		assert.strictEqual('costUsd' in result, false);
		assert.strictEqual(result.content, 'ok');
	});

	it('prices a fallback-served call at the fallback entry rate, not the requested one', async () => {
		const primary = defineBackend({
			name: 'primary',
			generate: async () => {
				throw new Error('provider down');
			},
		});
		const backup = backendReturning('backup', { promptTokens: 1_000_000, completionTokens: 0 });
		setGenerative('default', primary);
		setGenerative('backup', backup);
		setFallbackGroup('generative', 'default', ['backup']);
		setBackendPricing(primary, { inputPerMtok: 100, outputPerMtok: 100 });
		setBackendPricing(backup, { inputPerMtok: 1, outputPerMtok: 1 });
		const result = await new Models(writer()).generate('hi');
		assert.strictEqual(result.costUsd, 1);
	});

	it('an unpriced fallback leaves the call unpriced even when the requested entry is priced', async () => {
		const primary = defineBackend({
			name: 'primary',
			generate: async () => {
				throw new Error('provider down');
			},
		});
		setGenerative('default', primary);
		setGenerative('backup', backendReturning('backup', { promptTokens: 10, completionTokens: 10 }));
		setFallbackGroup('generative', 'default', ['backup']);
		setBackendPricing(primary, PRICING);
		const result = await new Models(writer()).generate('hi');
		assert.strictEqual(result.costUsd, undefined);
	});
});

describe('models.generative.<name>.pricing from config', () => {
	beforeEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
	});
	afterEach(() => {
		clearRegistry();
		clearRouting();
		resetModelsProjection();
	});

	it('attaches the declared pricing to the generative backend the entry builds', async () => {
		await bootstrapModels({
			models: {
				generative: { default: { backend: 'ollama', model: 'm', pricing: PRICING } },
				embedding: { default: { backend: 'ollama', model: 'e' } },
			},
		});
		assert.deepStrictEqual(getBackendPricing(getBackend('generative', 'default')), PRICING);
		assert.strictEqual(getBackendPricing(getBackend('embedding', 'default')), undefined);
	});

	it('a reload that changes or removes the price reprices the entry', async () => {
		await bootstrapModels({ models: { generative: { default: { backend: 'ollama', model: 'm', pricing: PRICING } } } });
		const repriced = { inputPerMtok: 1, outputPerMtok: 2 };
		await applyModelsConfig({ generative: { default: { backend: 'ollama', model: 'm', pricing: repriced } } });
		assert.deepStrictEqual(getBackendPricing(getBackend('generative', 'default')), repriced);
		await applyModelsConfig({ generative: { default: { backend: 'ollama', model: 'm' } } });
		assert.strictEqual(getBackendPricing(getBackend('generative', 'default')), undefined);
	});
});
