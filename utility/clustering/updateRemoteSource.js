'use strict';

const updateRemoteSourceValidator = require('../../validation/clustering/updateRemoteSourceValidator.js');
const hdbLogger = require('../logging/harper_logger.js');
const natsTerms = require('../../server/nats/utility/natsTerms.js');
const hdbTerms = require('../hdbTerms.ts');
const clusterUtils = require('../../utility/clustering/clusterUtilities.js');
const natsUtils = require('../../server/nats/utility/natsUtils.js');
const schemaMod = require('../../dataLayer/schema.js');
const CreateTableObject = require('../../dataLayer/CreateTableObject.js');
const { Node, NodeSubscription } = require('./NodeObject.js');
const UpdateRemoteResponseObject = require('./UpdateRemoteResponseObject.js');
const hdbUtils = require('../common_utils.js');
const envManager = require('../environment/environmentManager.js');
const { cloneDeep } = require('lodash');
const { broadcast } = require('../../server/threads/manageThreads.js');

module.exports = updateRemoteSource;

/**
 * Used by a "remote node" when an updateRemoteSources request is sent.
 * Will add or update a node connection/subscription.
 * @param request
 * @returns {Promise<UpdateRemoteResponseObject>}
 */
async function updateRemoteSource(request) {
	try {
		const validation = updateRemoteSourceValidator(request);
		if (validation) {
			hdbLogger.error(`Validation error in updateRemoteSource: ${validation.message}`);

			// If a validation error occurs return it to the originator node.
			return new UpdateRemoteResponseObject(natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, validation.message);
		}

		const { subscriptions, node_name, system_info } = request;
		let newSubsArray = [];
		let nodeRecord = cloneDeep(await clusterUtils.getNodeRecord(node_name));
		const updateRecord = !hdbUtils.isEmptyOrZeroLength(nodeRecord);
		nodeRecord = updateRecord ? nodeRecord[0] : nodeRecord;
		if (updateRecord) hdbLogger.trace(`Existing record found for ${node_name}, updating records subscriptions`);

		// For each subscription in the subscriptions array.
		for (let j = 0, subLength = subscriptions.length; j < subLength; j++) {
			const sub = subscriptions[j];
			const schema = sub.schema;
			const table = sub.table;

			// If the schema doesn't exist it is created.
			if (!hdbUtils.doesSchemaExist(schema)) {
				hdbLogger.trace(`updateRemoteSource creating schema: ${schema}`);
				try {
					await schemaMod.createSchema({ operation: 'create_schema', schema });
				} catch (error) {
					hdbLogger.error(error);
				}
			}

			// If the table doesn't exist it is created.
			if (table && !hdbUtils.doesTableExist(schema, table)) {
				const tableObj = new CreateTableObject(schema, table, sub.hash_attribute);
				if (sub.attributes) {
					tableObj.attributes = sub.attributes;
				}
				hdbLogger.trace(
					`updateRemoteSource creating table: ${table} in schema: ${schema} with attributes: ${JSON.stringify(
						sub.attributes
					)}`
				);
				try {
					await schemaMod.createTable(tableObj);
				} catch (error) {
					hdbLogger.error(error);
				}
			}

			hdbLogger.trace(`Creating local stream for ${schema}.${table}`);
			await natsUtils.createLocalTableStream(schema, table);

			// Will either remove/add consumer for this node on the other node. After that it will
			// either stop/start a msg iterator on this node for the consumer.
			if (updateRecord) {
				// Stop any existing iterators for sub before updating
				await natsUtils.updateConsumerIterator(schema, table, node_name, 'stop');
				await natsUtils.updateRemoteConsumer(sub, node_name);
				if (sub.subscribe === true) {
					await natsUtils.updateConsumerIterator(schema, table, node_name, 'start');
				}
			} else {
				await natsUtils.updateRemoteConsumer(sub, node_name);
				if (sub.subscribe === true) {
					await natsUtils.updateConsumerIterator(schema, table, node_name, 'start');
				} else {
					await natsUtils.updateConsumerIterator(schema, table, node_name, 'stop');
				}
			}

			// If a record for remote node already exists in hdbNodes table we update the subscriptions in it.
			if (updateRecord) {
				let matchFound = false;
				for (let x = 0, rLength = nodeRecord.subscriptions.length; x < rLength; x++) {
					const existingSub = nodeRecord.subscriptions[x];

					// If there is an existing matching subscription in the hdbNodes table update it.
					if (existingSub.schema === schema && existingSub.table === table) {
						existingSub.publish = sub.publish;
						existingSub.subscribe = sub.subscribe;
						matchFound = true;
						break;
					}
				}

				// If no matching subscription is found but there is a record in the table for the node push new sub to subscriptions array.
				if (!matchFound) {
					nodeRecord.subscriptions.push(new NodeSubscription(schema, table, sub.publish, sub.subscribe));
				}
			} else {
				// If there is no existing record for node push new sub to sub array.
				newSubsArray.push(new NodeSubscription(schema, table, sub.publish, sub.subscribe));
			}
		}

		// If there is no existing record for node in hdbNodes create a new one
		if (!updateRecord) {
			nodeRecord = new Node(node_name, newSubsArray, undefined);
			hdbLogger.trace(`No record found for ${node_name}, creating a new one`);
		}

		// nodeRecord doesnt have required prototypes which are required down the line, for this reason a new object is created.
		const upsertRecord = Object.create({});
		Object.assign(upsertRecord, nodeRecord);
		// Regardless of if record exists or not we add/update its system_info param.
		upsertRecord.system_info = system_info;
		await clusterUtils.upsertNodeRecord(upsertRecord);
		broadcast({
			type: 'nats_update',
		});

		return new UpdateRemoteResponseObject(
			natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.SUCCESS,
			`Node ${envManager.get(hdbTerms.CONFIG_PARAMS.CLUSTERING_NODENAME)} successfully updated remote source`,
			// Send this nodes system info back to the node the request came from
			await clusterUtils.getSystemInfo()
		);
	} catch (err) {
		hdbLogger.error(err);
		const errMsg = err.message ? err.message : err;

		// If an error occurs return it to the originator node.
		return new UpdateRemoteResponseObject(natsTerms.UPDATE_REMOTE_RESPONSE_STATUSES.ERROR, errMsg);
	}
}
