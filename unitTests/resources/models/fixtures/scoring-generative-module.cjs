'use strict';
// A generative module that also scores (#2838). `generate` answers `config.answers` in order;
// `scoreChoices` answers `config.scores` (arrays of log-likelihoods) in order, declines every call
// when `config.unsupported` is set, and is left out entirely when `config.scoreless` is set. Every
// call is appended to `calls` so a test can see which path the adapter took.
const { registerBackend, defineBackend } = require('#src/resources/models/backendRegistry');
const { ChoiceScoringUnsupportedError } = require('#src/resources/models/backendHelpers');

const calls = [];

module.exports = function register({ logicalName, kind, config }) {
	const answers = Array.isArray(config.answers) && config.answers.length > 0 ? config.answers : ['{}'];
	const scores = Array.isArray(config.scores) && config.scores.length > 0 ? config.scores : [[0]];
	let g = 0;
	let s = 0;
	registerBackend(
		kind,
		logicalName,
		defineBackend({
			name: `module:scoring-${logicalName}`,
			generate: async () => {
				calls.push({ method: 'generate' });
				return {
					status: 'completed',
					output: { content: answers[g++ % answers.length], finishReason: 'stop' },
					usage: { promptTokens: 1, completionTokens: 1 },
				};
			},
			scoreChoices: config.scoreless
				? undefined
				: async (input, choices) => {
						calls.push({ method: 'scoreChoices', input, choices });
						if (config.unsupported) throw new ChoiceScoringUnsupportedError('fixture: declined', { promptTokens: 7 });
						const answer = scores[s++ % scores.length];
						return {
							status: 'completed',
							output: { logLikelihoods: choices.map((_, i) => answer[i] ?? 0) },
							usage: { promptTokens: 2, completionTokens: 1 },
						};
					},
		})
	);
};
module.exports.calls = calls;
