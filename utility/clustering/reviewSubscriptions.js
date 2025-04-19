'use strict';

const natsUtils = require('../../server/nats/utility/natsUtils.js');
const hdbUtils = require('../common_utils.js');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const hdbTerms = require('../hdbTerms.ts');
const hdbLogger = require('../logging/harper_logger.js');
const schemaMod = require('../../dataLayer/schema.js');
const CreateTableObject = require('../../dataLayer/CreateTableObject.js');
const { RemotePayloadObject } = require('./RemotePayloadObject.js');
const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { HTTP_STATUS_CODES } = hdbErrors;
const { NodeSubscription } = require('./NodeObject.js');

module.exports = reviewSubscriptions;

/**
 * Reviews the passed subscriptions to see if it can/needs to create schema and/or tables for the subscriptions locally.
 * It does this by - getting describe all from remote node and comparing it to the subscriptions.
 * If any of the subs schema/table exits remotely but not locally it will create them.
 * @param subs
 * @param remoteNodeName
 * @returns {Promise<{added: *[], skipped: *[]}>}
 */
async function reviewSubscriptions(subs, remoteNodeName) {
	let remoteDescribeAllReq;
	try {
		remoteDescribeAllReq = await natsUtils.request(
			`${remoteNodeName}.${natsTerms.REQUEST_SUFFIX}`,
			new RemotePayloadObject(hdbTerms.OPERATIONS_ENUM.DESCRIBE_ALL, remoteNodeName, undefined, undefined)
		);

		hdbLogger.trace('Response from remote describe all request:', remoteDescribeAllReq);
	} catch (err) {
		hdbLogger.error(`addNode received error from describe all request to remote node: ${err}`);
		const errorMsg = natsUtils.requestErrorHandler(err, 'add_node', remoteNodeName);
		throw handleHDBError(new Error(), errorMsg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', errorMsg);
	}

	// If an error is received from the remote node abort add node and throw error
	if (remoteDescribeAllReq.status === natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR) {
		const errMsg = `Error returned from remote node ${remoteNodeName}: ${remoteDescribeAllReq.message}`;
		throw handleHDBError(new Error(), errMsg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', errMsg);
	}

	const remoteDescribeAll = remoteDescribeAllReq.message;
	let skipped = [];
	let added = [];
	for (const sub of subs) {
		const { table: tableReq } = sub;
		const schemaReq = sub.database ?? sub.schema ?? 'data';
		// System schema/table should exist on all nodes so no need to review
		if (schemaReq === hdbTerms.SYSTEM_SCHEMA_NAME) {
			await natsUtils.createLocalTableStream(schemaReq, tableReq);
			const nodeSub = new NodeSubscription(schemaReq, tableReq, sub.publish, sub.subscribe);
			nodeSub.start_time = sub.start_time;
			added.push(nodeSub);
			continue;
		}

		const schemaExistsLocally = hdbUtils.doesSchemaExist(schemaReq);
		const schemaExistsRemote = remoteDescribeAll[schemaReq] !== undefined;
		const tableExistsLocally = tableReq ? hdbUtils.doesTableExist(schemaReq, tableReq) : true;
		const tableExistsRemote = tableReq ? remoteDescribeAll?.[schemaReq]?.[tableReq] !== undefined : true;

		// If schema/table don't exist on either nodes, skip the sub.
		// This should ensure nothing is created if schema exists but no tables do.
		if ((!schemaExistsLocally && !schemaExistsRemote) || (!tableExistsLocally && !tableExistsRemote)) {
			skipped.push(sub);
			continue;
		}

		// If the schema exists on remote but not locally, create it locally.
		if (!schemaExistsLocally && schemaExistsRemote) {
			hdbLogger.trace(`addNode creating schema: ${schemaReq}`);
			await schemaMod.createSchema({ operation: 'create_schema', schema: schemaReq });
		}

		// If the table exists on remote node but not locally, create it locally.
		if (!tableExistsLocally && tableExistsRemote) {
			hdbLogger.trace(
				`addNode creating table: ${tableReq} in schema: ${schemaReq} with attributes ${JSON.stringify(
					remoteDescribeAll[schemaReq][tableReq].attributes
				)}`
			);
			const tableObj = new CreateTableObject(
				schemaReq,
				tableReq,
				remoteDescribeAll[schemaReq][tableReq]['hash_attribute']
			);
			if (remoteDescribeAll[schemaReq][tableReq].attributes)
				tableObj.attributes = remoteDescribeAll[schemaReq][tableReq].attributes;
			await schemaMod.createTable(tableObj);
		}

		// Create local streams for all the tables in the subscriptions array.
		// This needs to happen before any streams are added to the work queue on either nodes.
		// If the stream has already been created nothing will happen.
		await natsUtils.createLocalTableStream(schemaReq, tableReq);
		const nodeSub = new NodeSubscription(schemaReq, tableReq, sub.publish, sub.subscribe);
		nodeSub.start_time = sub.start_time;
		added.push(nodeSub);
	}

	return {
		added,
		skipped,
	};
}
