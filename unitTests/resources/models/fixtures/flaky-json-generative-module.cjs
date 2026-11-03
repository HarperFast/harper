'use strict';
// Answers `config.answer` and fails every call from `config.failFrom` on; `config.name` lets two entries
// share a backend name, as two entries of one provider do.
const { registerBackend, defineBackend } = require('#src/resources/models/backendRegistry');

module.exports = function register({ logicalName, kind, config }) {
	let calls = 0;
	registerBackend(
		kind,
		logicalName,
		defineBackend({
			name: config.name ?? `module:flaky-${logicalName}`,
			structuredOutput: true,
			generate: async () => {
				calls++;
				if (config.failFrom !== undefined && calls >= config.failFrom) throw new Error('fixture: unavailable');
				return { status: 'completed', output: { content: config.answer, finishReason: 'stop' } };
			},
		})
	);
};
