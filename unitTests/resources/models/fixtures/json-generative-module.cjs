'use strict';
// #2779 test fixture: a config-selectable generative backend that answers from
// `config.answers` in order (cycling), so a `models.decision` entry backed by the
// generative adapter can be driven end to end through bootstrap with scripted votes.
const { registerBackend, defineBackend } = require('#src/resources/models/backendRegistry');

module.exports = function register({ logicalName, kind, config }) {
	const answers = Array.isArray(config.answers) && config.answers.length > 0 ? config.answers : ['{}'];
	let i = 0;
	registerBackend(
		kind,
		logicalName,
		defineBackend({
			name: `module:json-${logicalName}`,
			generate: async () => ({
				status: 'completed',
				output: { content: answers[i++ % answers.length], finishReason: 'stop' },
				usage: { promptTokens: 1, completionTokens: 1 },
			}),
		})
	);
};
