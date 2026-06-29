'use strict';
// #1471 test fixture: a backend module exposing a named `register` export
// (rather than a default-export factory).
const { registerBackend, defineBackend } = require('#src/resources/models/backendRegistry');

exports.register = function register({ logicalName, kind }) {
	registerBackend(
		kind,
		logicalName,
		defineBackend({
			name: 'module:register-export',
			embed: async (input) => ({ status: 'completed', output: [input].flat().map(() => Float32Array.from([1])) }),
		})
	);
};
