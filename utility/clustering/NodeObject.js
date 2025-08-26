'use strict';

class Node {
	/**
	 * @param {string} node_name
	 * @param {Array.<NodeSubscription>} subscriptions
	 * @param {Object} system_info - {hdbVersion, platform, nodeVersion}
	 */
	constructor(node_name, subscriptions, system_info) {
		this.name = node_name;
		this.subscriptions = subscriptions;
		this.system_info = system_info;
	}
}

class NodeSubscription {
	/**
	 * @param {string} schema
	 * @param {string} table
	 * @param {boolean} publish
	 * @param {boolean} subscribe
	 */
	constructor(schema, table, publish, subscribe) {
		this.schema = schema;
		this.table = table;
		this.publish = publish;
		this.subscribe = subscribe;
	}
}

module.exports = {
	Node,
	NodeSubscription,
};
