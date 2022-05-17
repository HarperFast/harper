'use strict';

const nats_terms = require('./natsTerms');

/**
 * This class represents the config consumed by the Nats hub server.
 */
class HubConfigObject {
	constructor(
		port,
		node_name,
		pid_file,
		leafnodes_port,
		cluster_name,
		cluster_port,
		cluster_routes,
		sys_users,
		hdb_users
	) {
		this.port = port;
		this.server_name = node_name + nats_terms.SERVER_SUFFIX.HUB;
		this.pid_file = pid_file;
		this.jetstream = {
			enabled: false,
		};
		this.leafnodes = {
			port: leafnodes_port,
		};
		this.cluster = {
			name: cluster_name,
			port: cluster_port,
			routes: cluster_routes,
		};
		this.accounts = {
			SYS: {
				users: sys_users,
			},
			HDB: {
				users: hdb_users,
			},
		};
		this.system_account = 'SYS';
	}
}

module.exports = HubConfigObject;
