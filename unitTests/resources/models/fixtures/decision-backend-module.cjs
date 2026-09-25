'use strict';
// #2779 test fixture: a config-selectable decision backend. Registers under the kind
// bootstrap passes (`decision`) and always chooses `config.winner` with certainty.
const { registerBackend, defineBackend } = require('#src/resources/models/backendRegistry');
const { allowedValues } = require('#src/resources/models/decision');

module.exports = function register({ logicalName, kind, config }) {
	registerBackend(
		kind,
		logicalName,
		defineBackend({
			name: `module:decision-${logicalName}`,
			calibrated: config.calibrated === true,
			decide: async (_state, schema) => ({
				status: 'completed',
				output: {
					distribution: allowedValues(schema).map((value) => ({ value, probability: value === config.winner ? 1 : 0 })),
				},
				usage: { promptTokens: 3 },
			}),
		})
	);
};
