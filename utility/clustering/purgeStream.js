'use strict';

const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const purge_stream_validator = require('../../validation/clustering/purgeStreamValidator');
const nats_utils = require('../../server/nats/utility/natsUtils');
const clustering_utils = require('./clusterUtilities');

module.exports = purgeStream;

/**
 * Removes all messaged from a local nats stream.
 * When clustering is enabled streams are how we store transactions on individual tables.
 * @param req
 * @returns {Promise<string>}
 */
async function purgeStream(req) {
	const validation_err = purge_stream_validator(req);
	if (validation_err) {
		throw handleHDBError(
			validation_err,
			validation_err.message,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}

	clustering_utils.checkClusteringEnabled();

	const { schema, table } = req;
	await nats_utils.purgeTableStream(schema, table);

	return `Successfully purged table '${schema}.${table}'`;
}
