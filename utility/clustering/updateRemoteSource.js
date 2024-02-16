'use strict';

const update_remote_source_validator = require('../../validation/clustering/updateRemoteSourceValidator');
const hdb_logger = require('../logging/harper_logger');
const nats_terms = require('../../server/nats/utility/natsTerms');
const hdb_terms = require('../hdbTerms');
const cluster_utils = require('../../utility/clustering/clusterUtilities');
const nats_utils = require('../../server/nats/utility/natsUtils');
const schema_mod = require('../../dataLayer/schema');
const CreateTableObject = require('../../dataLayer/CreateTableObject');
const { Node, NodeSubscription } = require('./NodeObject');
const UpdateRemoteResponseObject = require('./UpdateRemoteResponseObject');
const hdb_utils = require('../common_utils');
const env_manager = require('../environment/environmentManager');
const { cloneDeep } = require('lodash');
const { broadcast } = require('../../server/threads/manageThreads');

module.exports = updateRemoteSource;

/**
 * Used by a "remote node" when an update_remote_sources request is sent.
 * Will add or update a node connection/subscription.
 * @param request
 * @returns {Promise<UpdateRemoteResponseObject>}
 */
async function updateRemoteSource(request) {
	try {
		const validation = update_remote_source_validator(request);
		if (validation) {
			hdb_logger.error(`Validation error in updateRemoteSource: ${validation.message}`);

			// If a validation error occurs return it to the originator node.
			return new UpdateRemoteResponseObject(nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, validation.message);
		}

		const { subscriptions, node_name, system_info } = request;
		let new_subs_array = [];
		let node_record = cloneDeep(await cluster_utils.getNodeRecord(node_name));
		const update_record = !hdb_utils.isEmptyOrZeroLength(node_record);
		node_record = update_record ? node_record[0] : node_record;
		if (update_record) hdb_logger.trace(`Existing record found for ${node_name}, updating records subscriptions`);

		// For each subscription in the subscriptions array.
		for (let j = 0, sub_length = subscriptions.length; j < sub_length; j++) {
			const sub = subscriptions[j];
			const schema = sub.schema;
			const table = sub.table;

			// If the schema doesn't exist it is created.
			if (!hdb_utils.doesSchemaExist(schema)) {
				hdb_logger.trace(`updateRemoteSource creating schema: ${schema}`);
				try {
					await schema_mod.createSchema({ operation: 'create_schema', schema });
				} catch (error) {
					hdb_logger.error(error);
				}
			}

			// If the table doesn't exist it is created.
			if (table && !hdb_utils.doesTableExist(schema, table)) {
				const table_obj = new CreateTableObject(schema, table, sub.hash_attribute);
				if (sub.attributes) {
					table_obj.attributes = sub.attributes;
				}
				hdb_logger.trace(
					`updateRemoteSource creating table: ${table} in schema: ${schema} with attributes: ${JSON.stringify(
						sub.attributes
					)}`
				);
				try {
					await schema_mod.createTable(table_obj);
				} catch (error) {
					hdb_logger.error(error);
				}

				// Create a stream for the new table
				hdb_logger.trace(`Creating local stream for ${schema}.${table}`);
				await nats_utils.createLocalTableStream(schema, table);
			}

			// System tables might not have a nats stream, if they want to replicate, they will need one.
			if (schema === hdb_terms.SYSTEM_SCHEMA_NAME) {
				await nats_utils.createLocalTableStream(schema, table);
			}

			// Will either remove/add consumer for this node on the other node. After that it will
			// either stop/start a msg iterator on this node for the consumer.
			if (update_record) {
				// Stop any existing iterators for sub before updating
				await nats_utils.updateConsumerIterator(schema, table, node_name, 'stop');
				await nats_utils.updateRemoteConsumer(sub, node_name);
				if (sub.subscribe === true) {
					await nats_utils.updateConsumerIterator(schema, table, node_name, 'start');
				}
			} else {
				await nats_utils.updateRemoteConsumer(sub, node_name);
				if (sub.subscribe === true) {
					await nats_utils.updateConsumerIterator(schema, table, node_name, 'start');
				} else {
					await nats_utils.updateConsumerIterator(schema, table, node_name, 'stop');
				}
			}

			// If a record for remote node already exists in hdb_nodes table we update the subscriptions in it.
			if (update_record) {
				let match_found = false;
				for (let x = 0, r_length = node_record.subscriptions.length; x < r_length; x++) {
					const existing_sub = node_record.subscriptions[x];

					// If there is an existing matching subscription in the hdb_nodes table update it.
					if (existing_sub.schema === schema && existing_sub.table === table) {
						existing_sub.publish = sub.publish;
						existing_sub.subscribe = sub.subscribe;
						match_found = true;
						break;
					}
				}

				// If no matching subscription is found but there is a record in the table for the node push new sub to subscriptions array.
				if (!match_found) {
					node_record.subscriptions.push(new NodeSubscription(schema, table, sub.publish, sub.subscribe));
				}
			} else {
				// If there is no existing record for node push new sub to sub array.
				new_subs_array.push(new NodeSubscription(schema, table, sub.publish, sub.subscribe));
			}
		}

		// If there is no existing record for node in hdb_nodes create a new one
		if (!update_record) {
			node_record = new Node(node_name, new_subs_array, undefined);
			hdb_logger.trace(`No record found for ${node_name}, creating a new one`);
		}

		// node_record doesnt have required prototypes which are required down the line, for this reason a new object is created.
		const upsert_record = Object.create({});
		Object.assign(upsert_record, node_record);
		// Regardless of if record exists or not we add/update its system_info param.
		upsert_record.system_info = system_info;
		await cluster_utils.upsertNodeRecord(upsert_record);
		broadcast({
			type: 'nats_update',
		});

		return new UpdateRemoteResponseObject(
			nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.SUCCESS,
			`Node ${env_manager.get(hdb_terms.CONFIG_PARAMS.CLUSTERING_NODENAME)} successfully updated remote source`,
			// Send this nodes system info back to the node the request came from
			await cluster_utils.getSystemInfo()
		);
	} catch (err) {
		hdb_logger.error(err);
		const err_msg = err.message ? err.message : err;

		// If an error occurs return it to the originator node.
		return new UpdateRemoteResponseObject(nats_terms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, err_msg);
	}
}
