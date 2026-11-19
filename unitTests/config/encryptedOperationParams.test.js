'use strict';

// `env.get` resolves only names in CONFIG_PARAM_MAP (populated from CONFIG_PARAMS by lowercased name);
// an unregistered param reads as undefined forever and its compiled-in default silently applies.

const assert = require('node:assert');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');

describe('operationsApi.encryptedOperation registration', () => {
	for (const [key, name] of [
		['OPERATIONSAPI_ENCRYPTEDOPERATION_MAXAGE', 'operationsApi_encryptedOperation_maxAge'],
		['OPERATIONSAPI_ENCRYPTEDOPERATION_MAXSIZE', 'operationsApi_encryptedOperation_maxSize'],
	]) {
		it(`registers ${name} so env.get and set_configuration resolve it`, () => {
			assert.strictEqual(CONFIG_PARAMS[key], name);
			assert.strictEqual(CONFIG_PARAM_MAP[name.toLowerCase()], name);
		});
	}
});
