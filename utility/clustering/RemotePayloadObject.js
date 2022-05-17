'use strict';

/**
 * The class represents the payload sent to another node when updating remote sources.
 */
class RemotePayloadObject {
	constructor(operation, node_name, subscriptions) {
		this.operation = operation;
		this.node_name = node_name;
		this.subscriptions = subscriptions;
	}
}

/**
 * This class represents one subscription in the connections class above
 */
class RemotePayloadSubscription {
	constructor(schema, table, hash_attribute, publish, subscribe) {
		this.schema = schema;
		this.table = table;
		this.hash_attribute = hash_attribute;
		this.publish = publish;
		this.subscribe = subscribe;
	}
}

module.exports = {
	RemotePayloadObject,
	RemotePayloadSubscription,
};
