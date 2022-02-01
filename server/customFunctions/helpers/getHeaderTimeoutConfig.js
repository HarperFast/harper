'use strict';

const env = require('../../../utility/environment/environmentManager');
env.initSync();
const terms = require('../../../utility/hdbTerms');

/**
 * Returns header timeout value from config file
 * @returns {*}
 */
function getHeaderTimeoutConfig() {
	return env.get(terms.CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_HEADERSTIMEOUT);
}

module.exports = getHeaderTimeoutConfig;
