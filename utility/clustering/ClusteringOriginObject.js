'use strict';

class ClusteringOriginObject {
	constructor(timestamp, user, node_name) {
		this.timestamp = timestamp;
		this.user = user;
		this.node_name = node_name;
	}
}

module.exports = ClusteringOriginObject;
