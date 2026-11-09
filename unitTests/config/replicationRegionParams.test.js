'use strict';

// `env.get` resolves only names registered in CONFIG_PARAMS (harper-pro#734).

const assert = require('node:assert');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');

describe('replication region and gateway param registration (harper-pro#1291)', () => {
	it('registers both in CONFIG_PARAMS and CONFIG_PARAM_MAP', () => {
		assert.strictEqual(CONFIG_PARAMS.REPLICATION_REGION, 'replication_region');
		assert.strictEqual(CONFIG_PARAMS.REPLICATION_GATEWAY, 'replication_gateway');
		assert.strictEqual(CONFIG_PARAM_MAP['replication_region'], 'replication_region');
		assert.strictEqual(CONFIG_PARAM_MAP['replication_gateway'], 'replication_gateway');
	});
});
