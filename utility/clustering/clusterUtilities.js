'use strict';

const insert = require('../../dataLayer/insert.js');
const hdbUtils = require('../common_utils.js');
const util = require('util');
const terms = require('../hdbTerms.ts');
const envMgr = require('../environment/environmentManager.js');
envMgr.initSync();
const auth = require('../../security/fastifyAuth.js');
const search = require('../../dataLayer/search.js');
const { Node, NodeSubscription } = require('./NodeObject.js');
const SearchByHashObject = require('../../dataLayer/SearchByHashObject.js');
const UpsertObject = require('../../dataLayer/UpsertObject.js');
const { RemotePayloadObject, RemotePayloadSubscription } = require('./RemotePayloadObject.js');
const { handleHDBError, hdbErrors } = require('../errors/hdbError.js');
const { HTTP_STATUS_CODES, HDB_ERROR_MSGS } = hdbErrors;
const SearchObject = require('../../dataLayer/SearchObject.js');
const systemInformation = require('../environment/systemInformation.js');
const { packageJson } = require('../packageUtils.js');
const { getDatabases } = require('../../resources/databases.ts');

//Promisified functions
const pAuthAuthorize = util.promisify(auth.authorize);
const pSearchByHash = search.searchByHash;
const pSearchByValue = search.searchByValue;

module.exports = {
	isEmpty,
	getNodeRecord,
	upsertNodeRecord,
	buildNodePayloads,
	checkClusteringEnabled,
	getAllNodeRecords,
	getSystemInfo,
	reverseSubscription,
};

/**
 * Test if the passed value is null or undefined.  This will not check string length.
 * @param value - the value to test
 * @returns {boolean}
 */
function isEmpty(value) {
	return value === undefined || value === null;
}

/**
 * Get a record from the hdbNodes table.
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
	return pSearchByHash(qry);
}

/**
 * Upserts a node record into the hdbNode table
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
	if (hdbUtils.isEmpty(subscription.subscribe) || hdbUtils.isEmpty(subscription.publish)) {
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
 * @param localNodeName
 * @param operation
 * @param system_info
 * @returns {RemotePayloadObject}
 */
function buildNodePayloads(subscriptions, localNodeName, operation, system_info) {
	let remoteNodeSubs = [];
	for (let i = 0, subLength = subscriptions.length; i < subLength; i++) {
		const subscription = subscriptions[i];
		const { schema, table } = subscription;
		const hash_attribute = hdbUtils.getTableHashAttribute(schema, table);

		const { subscribe, publish } = reverseSubscription(subscription);
		const tableClass = getDatabases()[schema]?.[table];
		const remotePayloadSub = new RemotePayloadSubscription(
			schema,
			table,
			hash_attribute,
			publish,
			subscribe,
			subscription.start_time,
			tableClass.schemaDefined ? tableClass.attributes : undefined
		);
		remoteNodeSubs.push(remotePayloadSub);
	}

	return new RemotePayloadObject(operation, localNodeName, remoteNodeSubs, system_info);
}

/**
 * Check to see if clustering is enabled in hdb config. If it is not an error is thrown.
 */
function checkClusteringEnabled() {
	if (!envMgr.get(terms.CONFIG_PARAMS.CLUSTERING_ENABLED)) {
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
 * Gets all node records from the hdbNodes table
 * @returns {Promise<*>}
 */
async function getAllNodeRecords() {
	const searchObj = new SearchObject(
		terms.SYSTEM_SCHEMA_NAME,
		terms.SYSTEM_TABLE_NAMES.NODE_TABLE_NAME,
		'name',
		'*',
		undefined,
		['*']
	);

	return Array.from(await pSearchByValue(searchObj));
}

/**
 * Builds the system info param that is used in hdbNodes table and cluster status.
 * @returns {Promise<{node_version: *, platform: string, hdb_version: *}>}
 */
async function getSystemInfo() {
	const sysInfo = await systemInformation.getSystemInformation();
	return {
		hdb_version: packageJson.version,
		node_version: sysInfo.node_version,
		platform: sysInfo.platform,
	};
}
