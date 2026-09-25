'use strict';
// #2779 test fixture: a config-selectable generative backend that answers from
// `config.answers` in order (cycling), so a `models.decision` entry backed by the
// generative adapter can be driven end to end through bootstrap with scripted votes.
// It refuses a request whose response schema is not the strict object shape a
// structured-output provider requires, so the adapter's translation is exercised too.
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
