'use strict';

const insert = require('../../dataLayer/insert');
const hdb_utils = require('../common_utils');
const util = require('util');
const terms = require('../hdbTerms');
const env_mgr = require('../environment/environmentManager');
env_mgr.initSync();
const auth = require('../../security/fastifyAuth');
const search = require('../../dataLayer/search');
const { Node, NodeSubscription } = require('./NodeObject');
const SearchByHashObject = require('../../dataLayer/SearchByHashObject');
const UpsertObject = require('../../dataLayer/UpsertObject');
const { RemotePayloadObject, RemotePayloadSubscription } = require('./RemotePayloadObject');
const { handleHDBError, hdb_errors } = require('../errors/hdbError');
const { HTTP_STATUS_CODES, HDB_ERROR_MSGS } = hdb_errors;
const SearchObject = require('../../dataLayer/SearchObject');
const system_information = require('../environment/systemInformation');
const { packageJson } = require('../packageUtils');
const { getDatabases } = require('../../resources/databases');

//Promisified functions
const p_auth_authorize = util.promisify(auth.authorize);
const p_search_by_hash = search.searchByHash;
const p_search_by_value = search.searchByValue;

module.exports = {
	authHeaderToUser,
	isEmpty,
	getNodeRecord,
	upsertNodeRecord,
	buildNodePayloads,
	checkClusteringEnabled,
	getAllNodeRecords,
	getSystemInfo,
	reverseSubscription,
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

	const { schema, table, hash_attribute } = subscription;

	const result = {
		schema,
		table,
		hash_attribute,
	};

	if (subscription.subscribe === true && subscription.publish === false) {
		result.subscribe = false;
		result.publish = true;
	} else if (subscription.subscribe === false && subscription.publish === true) {
		result.subscribe = true;
		result.publish = false;
	} else {
		result.subscribe = subscription.subscribe;
		result.publish = subscription.publish;
	}

	return result;
}

/**
 * Build that payload that is required by remote node to add/update a node/subscriptions
 * @param subscriptions
 * @param local_node_name
 * @param operation
 * @param system_info
 * @returns {RemotePayloadObject}
 */
function buildNodePayloads(subscriptions, local_node_name, operation, system_info) {
	let remote_node_subs = [];
	for (let i = 0, sub_length = subscriptions.length; i < sub_length; i++) {
		const subscription = subscriptions[i];
		const { schema, table } = subscription;
		const hash_attribute = hdb_utils.getTableHashAttribute(schema, table);

		const { subscribe, publish } = reverseSubscription(subscription);
		const table_class = getDatabases()[schema]?.[table];
		const remote_payload_sub = new RemotePayloadSubscription(
			schema,
			table,
			hash_attribute,
			publish,
			subscribe,
			subscription.start_time,
			table_class.schemaDefined ? table_class.attributes : undefined
		);
		remote_node_subs.push(remote_payload_sub);
	}

	return new RemotePayloadObject(operation, local_node_name, remote_node_subs, system_info);
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

	return Array.from(await p_search_by_value(search_obj));
}

/**
 * Builds the system info param that is used in hdb_nodes table and cluster status.
 * @returns {Promise<{node_version: *, platform: string, hdb_version: *}>}
 */
async function getSystemInfo() {
	const sys_info = await system_information.getSystemInformation();
	return {
		hdb_version: packageJson.version,
		node_version: sys_info.node_version,
		platform: sys_info.platform,
	};
}
