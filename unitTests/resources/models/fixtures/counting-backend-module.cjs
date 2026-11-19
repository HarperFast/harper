'use strict';
// Reload-test fixture: counts factory invocations so a test can assert an entry was (or was not)
// reconstructed. Same register-function shape as embed-backend-module.cjs.
const { registerBackend, defineBackend } = require('#src/resources/models/backendRegistry');

module.exports = function register({ logicalName, kind, config }) {
	globalThis.__countingBackendBuilds = (globalThis.__countingBackendBuilds ?? 0) + 1;
	registerBackend(
		kind,
		logicalName,
		defineBackend({
			name: `counting:${config.model ?? 'test'}`,
			embed: async (input) => {
				const texts = Array.isArray(input) ? input : [input];
				return { status: 'completed', output: texts.map(() => Float32Array.from([1, 2, 3])) };
			},
		})
	);
};
