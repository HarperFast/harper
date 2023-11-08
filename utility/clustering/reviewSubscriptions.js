'use strict';

const nats_utils = require('../../server/nats/utility/natsUtils');
const hdb_utils = require('../common_utils');
const nats_terms = require('../../server/nats/utility/natsTerms');
const hdb_terms = require('../hdbTerms');
const hdb_logger = require('../logging/harper_logger');
const schema_mod = require('../../dataLayer/schema');
const CreateTableObject = require('../../dataLayer/CreateTableObject');
const { RemotePayloadObject } = require('./RemotePayloadObject');
const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { HTTP_STATUS_CODES } = hdb_errors;
const { NodeSubscription } = require('./NodeObject');

module.exports = reviewSubscriptions;

/**
 * Reviews the passed subscriptions to see if it can/needs to create schema and/or tables for the subscriptions locally.
 * It does this by - getting describe all from remote node and comparing it to the subscriptions.
 * If any of the subs schema/table exits remotely but not locally it will create them.
 * @param subs
 * @param remote_node_name
 * @returns {Promise<{added: *[], skipped: *[]}>}
 */
async function reviewSubscriptions(subs, remote_node_name) {
	let remote_describe_all_req;
	try {
		remote_describe_all_req = await nats_utils.request(
			`${remote_node_name}.${nats_terms.REQUEST_SUFFIX}`,
			new RemotePayloadObject(hdb_terms.OPERATIONS_ENUM.DESCRIBE_ALL, remote_node_name, undefined, undefined)
		);

		hdb_logger.trace('Response from remote describe all request:', remote_describe_all_req);
	} catch (err) {
		hdb_logger.error(`addNode received error from describe all request to remote node: ${err}`);
		const error_msg = nats_utils.requestErrorHandler(err, 'add_node', remote_node_name);
		throw handleHDBError(new Error(), error_msg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', error_msg);
	}

	// If an error is received from the remote node abort add node and throw error
	if (remote_describe_all_req.status === nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR) {
		const err_msg = `Error returned from remote node ${remote_node_name}: ${remote_describe_all_req.message}`;
		throw handleHDBError(new Error(), err_msg, HTTP_STATUS_CODES.INTERNAL_SERVER_ERROR, 'error', err_msg);
	}

	const remote_describe_all = remote_describe_all_req.message;
	let skipped = [];
	let added = [];
	for (const sub of subs) {
		const { table: table_req } = sub;
		const schema_req = sub.database ?? sub.schema ?? 'data';
		// System schema/table should exist on all nodes so no need to review
		if (schema_req === hdb_terms.SYSTEM_SCHEMA_NAME) {
			await nats_utils.createLocalTableStream(schema_req, table_req);
			const node_sub = new NodeSubscription(schema_req, table_req, sub.publish, sub.subscribe);
			node_sub.start_time = sub.start_time;
			added.push(node_sub);
			continue;
		}

		const schema_exists_locally = hdb_utils.doesSchemaExist(schema_req);
		const schema_exists_remote = remote_describe_all[schema_req] !== undefined;
		const table_exists_locally = table_req ? hdb_utils.doesTableExist(schema_req, table_req) : true;
		const table_exists_remote = table_req ? remote_describe_all?.[schema_req]?.[table_req] !== undefined : true;

		// If schema/table don't exist on either nodes, skip the sub.
		// This should ensure nothing is created if schema exists but no tables do.
		if ((!schema_exists_locally && !schema_exists_remote) || (!table_exists_locally && !table_exists_remote)) {
			skipped.push(sub);
			continue;
		}

		// If the schema exists on remote but not locally, create it locally.
		if (!schema_exists_locally && schema_exists_remote) {
			hdb_logger.trace(`addNode creating schema: ${schema_req}`);
			await schema_mod.createSchema({ operation: 'create_schema', schema: schema_req });
		}

		// If the table exists on remote node but not locally, create it locally.
		if (!table_exists_locally && table_exists_remote) {
			hdb_logger.trace(
				`addNode creating table: ${table_req} in schema: ${schema_req} with attributes ${JSON.stringify(
					remote_describe_all[schema_req][table_req].attributes
				)}`
			);
			const table_obj = new CreateTableObject(
				schema_req,
				table_req,
				remote_describe_all[schema_req][table_req]['hash_attribute']
			);
			if (remote_describe_all[schema_req][table_req].attributes)
				table_obj.attributes = remote_describe_all[schema_req][table_req].attributes;
			await schema_mod.createTable(table_obj);
		}

		// Create local streams for all the tables in the subscriptions array.
		// This needs to happen before any streams are added to the work queue on either nodes.
		// If the stream has already been created nothing will happen.
		await nats_utils.createLocalTableStream(schema_req, table_req);
		const node_sub = new NodeSubscription(schema_req, table_req, sub.publish, sub.subscribe);
		node_sub.start_time = sub.start_time;
		added.push(node_sub);
	}

	return {
		added,
		skipped,
	};
}
