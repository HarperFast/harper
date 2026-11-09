'use strict';

const assert = require('node:assert');
const { CONFIG_PARAMS, CONFIG_PARAM_MAP } = require('#src/utility/hdbTerms');
const env = require('#src/utility/environment/environmentManager');

describe('replication region and gateway param registration (harper-pro#734)', () => {
	it('registers both, so env.get and set_configuration resolve them', () => {
		assert.strictEqual(CONFIG_PARAM_MAP['replication_region'], CONFIG_PARAMS.REPLICATION_REGION);
		assert.strictEqual(CONFIG_PARAM_MAP['replication_gateway'], CONFIG_PARAMS.REPLICATION_GATEWAY);
		const prior = [env.get(CONFIG_PARAMS.REPLICATION_REGION), env.get(CONFIG_PARAMS.REPLICATION_GATEWAY)];
		try {
			env.setProperty(CONFIG_PARAMS.REPLICATION_REGION, 'us-east');
			env.setProperty(CONFIG_PARAMS.REPLICATION_GATEWAY, true);
			assert.strictEqual(env.get(CONFIG_PARAMS.REPLICATION_REGION), 'us-east');
			assert.strictEqual(env.get(CONFIG_PARAMS.REPLICATION_GATEWAY), true);
		} finally {
			env.setProperty(CONFIG_PARAMS.REPLICATION_REGION, prior[0]);
			env.setProperty(CONFIG_PARAMS.REPLICATION_GATEWAY, prior[1]);
		}
	});
});
