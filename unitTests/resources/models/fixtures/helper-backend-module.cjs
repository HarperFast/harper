'use strict';
// Reload-test fixture: registers a helper backend under a second name before its primary,
// optionally parking on globalThis.__helperGate so a test can observe mid-construction state.
const { registerBackend, defineBackend } = require('#src/resources/models/backendRegistry');

const embed = async (input) => ({
	status: 'completed',
	output: (Array.isArray(input) ? input : [input]).map(() => Float32Array.from([1, 2, 3])),
});

module.exports = async function register({ logicalName, kind, config }) {
	registerBackend(kind, config.helperName ?? `${logicalName}-helper`, defineBackend({ name: 'helper', embed }));
	if (globalThis.__helperGate) {
		globalThis.__helperGateReached = true;
		await globalThis.__helperGate;
	}
	registerBackend(kind, logicalName, defineBackend({ name: `primary:${config.model ?? 'test'}`, embed }));
};
