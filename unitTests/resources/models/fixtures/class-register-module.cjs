'use strict';
// #1471 test fixture: a default class export with a static `register` method
// (a `typeof === 'function'` default that must NOT be called as a plain factory).
const { registerBackend, defineBackend } = require('#src/resources/models/backendRegistry');

module.exports = class TestBackendModule {
	static register({ logicalName, kind }) {
		registerBackend(
			kind,
			logicalName,
			defineBackend({
				name: 'module:class-register',
				embed: async (input) => ({ status: 'completed', output: [input].flat().map(() => Float32Array.from([1])) }),
			})
		);
	}
};
