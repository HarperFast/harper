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
		cert_file,
		key_file,
		ca_file,
		insecure,
		verify,
		leafnodes_port,
		cluster_name,
		cluster_port,
		cluster_routes,
		sys_users,
		hdb_users
	) {
		this.port = port;
		if (ca_file === null) ca_file = undefined;
		this.server_name = node_name + nats_terms.SERVER_SUFFIX.HUB;
		this.pid_file = pid_file;
		this.max_payload = 67108864;
		this.reconnect_error_reports = 100;
		this.jetstream = {
			enabled: false,
		};
		this.tls = {
			cert_file,
			key_file,
			ca_file,
			insecure,
			verify,
		};
		this.leafnodes = {
			port: leafnodes_port,
			tls: {
				cert_file,
				key_file,
				ca_file,
				insecure,
			},
		};
		this.cluster = {
			name: cluster_name,
			port: cluster_port,
			routes: cluster_routes,
			tls: {
				cert_file,
				key_file,
				ca_file,
				insecure,
				verify,
			},
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
