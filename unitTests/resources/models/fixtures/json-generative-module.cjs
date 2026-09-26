'use strict';
// Answers from `config.answers` in order, and refuses a response schema that is not the strict
// object shape a structured-output provider requires.
const { registerBackend, defineBackend } = require('#src/resources/models/backendRegistry');

module.exports = function register({ logicalName, kind, config }) {
	const answers = Array.isArray(config.answers) && config.answers.length > 0 ? config.answers : ['{}'];
	let i = 0;
	registerBackend(
		kind,
		logicalName,
		defineBackend({
			name: `module:json-${logicalName}`,
			generate: async (_input, opts) => {
				const schema = opts.responseFormat?.schema;
				if (
					!schema ||
					schema.type !== 'object' ||
					schema.additionalProperties !== false ||
					!Array.isArray(schema.required) ||
					!Object.values(schema.properties).every((p) => typeof p.type === 'string')
				) {
					throw new Error('fixture: responseFormat.schema is not a strict object schema');
				}
				return {
					status: 'completed',
					output: { content: answers[i++ % answers.length], finishReason: 'stop' },
					usage: { promptTokens: 1, completionTokens: 1 },
				};
			},
		})
	);
};
