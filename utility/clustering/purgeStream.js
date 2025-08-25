'use strict';

const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;
const purgeStreamValidator = require('../../validation/clustering/purgeStreamValidator.js');
const natsUtils = require('../../server/nats/utility/natsUtils.js');
const clusteringUtils = require('./clusterUtilities.js');

module.exports = purgeStream;

/**
 * Removes all messaged from a local nats stream.
 * When clustering is enabled streams are how we store transactions on individual tables.
 * @param req
 * @returns {Promise<string>}
 */
async function purgeStream(req) {
	req.schema = req.schema ?? req.database;
	const validationErr = purgeStreamValidator(req);
	if (validationErr) {
		throw handleHDBError(
			validationErr,
			validationErr.message,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	clusteringUtils.checkClusteringEnabled();
	const { schema, table, options } = req;
	await natsUtils.purgeTableStream(schema, table, options);

	return `Successfully purged table '${schema}.${table}'`;
}
