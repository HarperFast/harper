'use strict';

const insert = require('../../data_layer/insert');
const hdb_utils = require('../common_utils');
const util = require('util');
const terms = require('../hdbTerms');
const env_mgr = require('../environment/environmentManager');
env_mgr.initSync();
const auth = require('../../security/auth');
const search = require('../../data_layer/search');
const { Node, NodeSubscription } = require('./NodeObject');
const SearchByHashObject = require('../../data_layer/SearchByHashObject');
const UpsertObject = require('../../data_layer/UpsertObject');
const { RemotePayloadObject, RemotePayloadSubscription } = require('./RemotePayloadObject');
const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { HTTP_STATUS_CODES, HDB_ERROR_MSGS } = hdb_errors;
const SearchObject = require('../../data_layer/SearchObject');
const system_information = require('../environment/systemInformation');
const version = require('../../bin/version');

//Promisified functions
const p_auth_authorize = util.promisify(auth.authorize);
const p_search_by_hash = util.promisify(search.searchByHash);
const p_search_by_value = util.promisify(search.searchByValue);

module.exports = {
	authHeaderToUser,
	isEmpty,
	getNodeRecord,
	upsertNodeRecord,
	buildNodePayloads,
	checkClusteringEnabled,
	getAllNodeRecords,
	getSystemInfo,
};

async function authHeaderToUser(json_body) {
	let req = { headers: { authorization: json_body.hdb_auth_header } };

	json_body.hdb_user = await p_auth_authorize(req, null);
	return json_body;
}

/**
 * Test if the passed value is null or undefined.  This will not check string length.
 * @param value - the value to test
 * @returns {boolean}
 */
function isEmpty(value) {
	return value === undefined || value === null;
}

/**
 * Get a record from the hdb_nodes table.
 * @param node_name
 * @returns {Promise<*>}
 */
async function getNodeRecord(node_name) {
	const qry = new SearchByHashObject(
		terms.SYSTEM_SCHEMA_NAME,
		terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME,
		[node_name],
		['*']
	);
	return p_search_by_hash(qry);
}

/**
 * Upserts a node record into the hdb_node table
 * @param node
 * @returns {Promise<{message: string, new_attributes: *, txn_time: *}|undefined>}
 */
async function upsertNodeRecord(node) {
	const qry = new UpsertObject(terms.SYSTEM_SCHEMA_NAME, terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME, [node]);
	return insert.upsert(qry);
}

/**
 * If subscribe/publish are not the same boolean, reverse their values.
 * If they are the same, leave them.
 * @param subscription
 * @returns {{subscribe: boolean, publish: boolean}|{subscribe, publish}}
 */
function reverseSubscription(subscription) {
	if (hdb_utils.isEmpty(subscription.subscribe) || hdb_utils.isEmpty(subscription.publish)) {
		throw new Error('Received invalid subscription object');
	}

	if (subscription.subscribe === true && subscription.publish === false) {
		return {
			subscribe: false,
			publish: true,
		};
	} else if (subscription.subscribe === false && subscription.publish === true) {
		return {
			subscribe: true,
			publish: false,
		};
	} else {
		return {
			subscribe: subscription.subscribe,
			publish: subscription.publish,
		};
	}
}

/**
 * Builds two objects. One is what will be inserted into the local hdb_nodes table.
 * The other is what is sent to the remote node when adding or updating a node.
 * @param subscriptions - array of nodes new/updated subscriptions
 * @param local_node_name
 * @param remote_node_name
 * @param operation
 * @param system_info
 * @param existing_subs - array of nodes existing subscriptions if they exist.
 * @returns {{remote_payload: RemotePayloadObject, node_record: Node}}
 */
function buildNodePayloads(
	subscriptions,
	local_node_name,
	remote_node_name,
	operation,
	system_info,
	existing_subs = undefined
) {
	let local_node_subs = [];
	let remote_node_subs = [];
	const update_record = !hdb_utils.isEmptyOrZeroLength(existing_subs);
	for (let i = 0, sub_length = subscriptions.length; i < sub_length; i++) {
		const subscription = subscriptions[i];
		const schema = subscription.schema;
		const table = subscription.table;
		const hash_attribute = hdb_utils.getTableHashAttribute(schema, table);
		if (hash_attribute === undefined) {
			throw new Error(`Undefined hash_attribute for ${schema}.${table}`);
		}

		// If there is already a record for the node we update that nodes subscription array.
		if (update_record) {
			let match_found = false;
			for (let j = 0, e_sub_length = existing_subs.length; j < e_sub_length; j++) {
				const existing_sub = existing_subs[j];
				// If there is an existing matching subscription in the hdb_nodes table update it.
				if (existing_sub.schema === schema && existing_sub.table === table) {
					existing_sub.publish = subscription.publish;
					existing_sub.subscribe = subscription.subscribe;
					match_found = true;
					break;
				}
			}

			// If no matching subscription is found but there is are existing sub add new sub to existing.
			if (!match_found) {
				existing_subs.push(new NodeSubscription(schema, table, subscription.publish, subscription.subscribe));
			}
		} else {
			// If there is no existing record for node create a new sub and push to sub array.
			const node_table_sub = new NodeSubscription(schema, table, subscription.publish, subscription.subscribe);
			local_node_subs.push(node_table_sub);
		}

		// This payload is being sent to the the remote node which means it will have
		// the reverse pub/sub of the local node.
		// We only include subs that are changing in the payload
		const { subscribe, publish } = reverseSubscription(subscription);
		const remote_payload_sub = new RemotePayloadSubscription(schema, table, hash_attribute, publish, subscribe);
		remote_node_subs.push(remote_payload_sub);
	}

	const node_subs = update_record ? existing_subs : local_node_subs;
	// system info is undefined here because we have nto yet received it from the remote node
	const node_record = new Node(remote_node_name, node_subs, undefined);
	const remote_payload = new RemotePayloadObject(operation, local_node_name, remote_node_subs, system_info);

	return {
		node_record,
		remote_payload,
	};
}

/**
 * Check to see if clustering is enabled in hdb config. If it is not an error is thrown.
 */
function checkClusteringEnabled() {
	if (!env_mgr.get(terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
		throw handleHDBError(
			new Error(),
			HDB_ERROR_MSGS.CLUSTERING_NOT_ENABLED,
			HTTP_STATUS_CODES.BAD_REQUEST,
			undefined,
			undefined,
			true
		);
	}
}

/**
 * Gets all node records from the hdb_nodes table
 * @returns {Promise<*>}
 */
async function getAllNodeRecords() {
	const search_obj = new SearchObject(
		terms.SYSTEM_SCHEMA_NAME,
		terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME,
		'name',
		'*',
		undefined,
		['*']
	);

	return p_search_by_value(search_obj);
}

/**
 * Builds the system info param that is used in hdb_nodes table and cluster status.
 * @returns {Promise<{node_version: *, platform: string, hdb_version: *}>}
 */
async function getSystemInfo() {
	const sys_info = await system_information.getSystemInformation();
	return {
		hdb_version: version.version(),
		node_version: sys_info.node_version,
		platform: sys_info.platform,
	};
}
