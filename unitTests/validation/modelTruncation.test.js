'use strict';

const assert = require('node:assert');
const { validateModelsBlock } = require('#src/validation/configValidator');

function block(truncation, kind = 'embedding', backend = 'openai') {
	return { [kind]: { default: { backend, apiKey: 'test', truncation } } };
}

describe('models truncation validation', () => {
	it("accepts truncation: 'vllm' on OpenAI embedding entries", () => {
		const result = validateModelsBlock(block('vllm'));
		assert.ifError(result.error);
		assert.strictEqual(result.value.embedding.default.truncation, 'vllm');
	});

	for (const truncation of ['tei', 'VLLM', '', true, 1, null, { side: 'right' }]) {
		it(`rejects truncation ${JSON.stringify(truncation)}`, () => {
			assert.ok(validateModelsBlock(block(truncation)).error);
		});
	}

	it('rejects truncation on OpenAI generative entries', () => {
		assert.ok(validateModelsBlock(block('vllm', 'generative')).error);
	});

	for (const backend of ['ollama', 'anthropic', 'bedrock']) {
		it(`rejects the OpenAI-only setting on ${backend}`, () => {
			const config = block('vllm', 'embedding', backend);
			if (backend !== 'anthropic') delete config.embedding.default.apiKey;
			assert.ok(validateModelsBlock(config).error);
		});
	}
});
