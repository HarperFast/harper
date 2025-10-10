'use strict';

const env = require('../../../utility/environment/environmentManager.js');
env.initSync();
const terms = require('../../../utility/hdbTerms.ts');

/**
 * Returns header timeout value from config file
 * @returns {*}
 */
function getHeaderTimeoutConfig() {
	return env.get(terms.CONFIG_PARAMS.HTTP_HEADERSTIMEOUT) ?? 60000;
}

module.exports = getHeaderTimeoutConfig;
