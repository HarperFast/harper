'use strict';
// Boot-composition fixture: records whether the entry named by config.wraps was already
// installed when this factory ran — the order-dependent pattern boot must preserve.
const { registerBackend, defineBackend, getBackend } = require('#src/resources/models/backendRegistry');

module.exports = function register({ logicalName, kind, config }) {
	const base = getBackend(kind, config.wraps ?? 'base');
	globalThis.__wrapperSawBase = base !== undefined;
	registerBackend(
		kind,
		logicalName,
		defineBackend({
			name: `wrapper:${config.wraps ?? 'base'}`,
			embed: async (input) => {
				const texts = Array.isArray(input) ? input : [input];
				return { status: 'completed', output: texts.map(() => Float32Array.from([9])) };
			},
		})
	);
};
