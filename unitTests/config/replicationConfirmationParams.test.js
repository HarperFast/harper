const assert = require('node:assert/strict');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');
const schema = require('../../config-root.schema.json');

describe('Replication confirmation configuration', () => {
	for (const [constant, name] of [
		['REPLICATION_CONFIRMATIONTIMEOUT', 'confirmationTimeout'],
		['REPLICATION_RESIDENCYCONFIRMATIONTIMEOUT', 'residencyConfirmationTimeout'],
	])
		it(`registers replication.${name} for configuration and bounds the native timer`, () => {
			assert.equal(CONFIG_PARAMS[constant], `replication_${name}`);
			assert.equal(CONFIG_PARAM_MAP[`replication_${name.toLowerCase()}`], `replication_${name}`);
			const option = schema.properties.replication.properties[name];
			assert.equal(option.type, 'integer');
			assert.equal(option.minimum, 1);
			assert.equal(option.maximum, 2147483647);
		});
});
