'use strict';

const assert = require('node:assert');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');
const env = require('#src/utility/environment/environmentManager');

describe('replication region param registration (harper-pro#734)', () => {
	it('registers it, so env.get and set_configuration resolve it', () => {
		assert.strictEqual(CONFIG_PARAM_MAP['replication_region'], CONFIG_PARAMS.REPLICATION_REGION);
		const prior = env.get(CONFIG_PARAMS.REPLICATION_REGION);
		try {
			env.setProperty(CONFIG_PARAMS.REPLICATION_REGION, 'us-east');
			assert.strictEqual(env.get(CONFIG_PARAMS.REPLICATION_REGION), 'us-east');
		} finally {
			env.setProperty(CONFIG_PARAMS.REPLICATION_REGION, prior);
		}
	});
});
