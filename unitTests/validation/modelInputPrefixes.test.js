'use strict';

const assert = require('node:assert');
const { validateModelsBlock } = require('#src/validation/configValidator');

function block(inputPrefixes, kind = 'embedding', backend = 'openai') {
	return { [kind]: { default: { backend, apiKey: 'test', inputPrefixes } } };
}

describe('models inputPrefixes validation', () => {
	for (const prefixes of [
		{},
		{ document: '' },
		{ query: 'query: ' },
		{ document: 'search_document: ', query: 'search_query: ' },
	]) {
		it(`accepts optional string prefixes without changing whitespace: ${JSON.stringify(prefixes)}`, () => {
			const result = validateModelsBlock(block(prefixes));
			assert.ifError(result.error);
			assert.deepStrictEqual(result.value.embedding.default.inputPrefixes, prefixes);
		});
	}

	for (const prefixes of [
		null,
		[],
		'prefix',
		{ document: 42 },
		{ query: true },
		{ document: null },
		{ typo: 'prefix' },
	]) {
		it(`rejects malformed prefixes: ${JSON.stringify(prefixes)}`, () => {
			assert.ok(validateModelsBlock(block(prefixes)).error);
		});
	}

	it('rejects inputPrefixes on OpenAI generative entries', () => {
		assert.ok(validateModelsBlock(block({ document: 'x' }, 'generative')).error);
	});

	for (const backend of ['ollama', 'anthropic', 'bedrock']) {
		it(`rejects the OpenAI-only setting on ${backend}`, () => {
			const config = block({ document: 'x' }, 'embedding', backend);
			if (backend !== 'anthropic') delete config.embedding.default.apiKey;
			assert.ok(validateModelsBlock(config).error);
		});
	}
});
