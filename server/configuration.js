'use strict';

const YAML = require('yaml');
const path = require('path');
const hdb_terms = require('../utility/hdbTerms');
const env = require('../utility/environment/environmentManager');
const fs = require('fs-extra');
env.initSync();

module.exports = {
	getConfiguration,
};

/**
 * this function returns all of the config settings
 * @returns {{}}
 */
function getConfiguration() {
	const config_doc = YAML.parseDocument(
		fs.readFileSync(path.join(env.get(hdb_terms.CONFIG_PARAMS.OPERATIONSAPI_ROOT), hdb_terms.HDB_CONFIG_FILE), 'utf8')
	);

	return config_doc.toJSON();
}
