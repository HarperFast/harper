'use strict';
// #1471 test fixture: a config-selectable backend module. The default export is
// a factory of the built-in register-function shape; it registers an embedding
// backend via the public registerBackend / defineBackend API.
const { registerBackend, defineBackend } = require('#src/resources/models/backendRegistry');

module.exports = function register({ logicalName, kind, config }) {
	registerBackend(
		kind,
		logicalName,
		defineBackend({
			name: `module:${config.model ?? 'test'}`,
			embed: async (input) => {
				const texts = Array.isArray(input) ? input : [input];
				return { status: 'completed', output: texts.map(() => Float32Array.from([1, 2, 3])) };
			},
		})
	);
};
