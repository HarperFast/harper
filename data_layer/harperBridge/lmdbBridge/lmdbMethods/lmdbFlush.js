'use strict';

const path = require('path');
const { getBaseSchemaPath } = require('../lmdbUtility/initializePaths');
const environment_utility = require('../../../../utility/lmdb/environmentUtility');

module.exports = {
	flush,
};

/**
 * This is wrapper for sync/flush to disk
 * @param schema
 * @param table
 * @returns {Promise<any>}
 */
async function flush(schema, table) {
	let env_base_path = path.join(getBaseSchemaPath(), schema.toString());
	let environment = await environment_utility.openEnvironment(env_base_path, table.toString());
	return environment.flushed;
}
