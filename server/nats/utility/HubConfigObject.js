'use strict';

const natsTerms = require('./natsTerms.js');

/**
 * This class represents the config consumed by the Nats hub server.
 */
class HubConfigObject {
	constructor(
		port,
		node_name,
		pidFile,
		cert_file,
		key_file,
		ca_file,
		insecure,
		verify,
		leafnodesPort,
		clusterName,
		clusterPort,
		clusterRoutes,
		sysUsers,
		hdbUsers
	) {
		this.port = port;
		if (ca_file === null) ca_file = undefined;
		this.server_name = node_name + natsTerms.SERVER_SUFFIX.HUB;
		this.pid_file = pidFile;
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
			port: leafnodesPort,
			tls: {
				cert_file,
				key_file,
				ca_file,
				insecure,
			},
		};
		this.cluster = {
			name: clusterName,
			port: clusterPort,
			routes: clusterRoutes,
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
				users: sysUsers,
			},
			HDB: {
				users: hdbUsers,
			},
		};
		this.system_account = 'SYS';
	}
}

module.exports = HubConfigObject;
