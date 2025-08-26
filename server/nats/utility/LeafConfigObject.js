'use strict';

const natsTerms = require('./natsTerms.js');

/**
 * This class represents the config consumed by the Nats leaf server.
 */
class LeafConfigObject {
	constructor(
		port,
		node_name,
		pidFile,
		jsStoreDir,
		lnRemotesUrlsSys,
		lnRemotesUrlsHdb,
		sysUsers,
		hdbUsers,
		cert_file,
		key_file,
		ca_file
	) {
		this.port = port;
		if (ca_file === null) ca_file = undefined;
		this.server_name = node_name + natsTerms.SERVER_SUFFIX.LEAF;
		this.pid_file = pidFile;
		this.max_payload = 67108864;
		this.jetstream = {
			enabled: true,
			store_dir: jsStoreDir,
			domain: node_name + natsTerms.SERVER_SUFFIX.LEAF,
		};
		this.tls = {
			cert_file,
			key_file,
			ca_file,
			// this is a local connection, with localhost, so we can't verify CAs and don't need to
			insecure: true,
		};
		this.leafnodes = {
			remotes: [
				{
					tls: {
						ca_file,
						insecure: true,
					},
					urls: lnRemotesUrlsSys,
					account: 'SYS',
				},
				{
					tls: {
						ca_file,
						insecure: true,
					},
					urls: lnRemotesUrlsHdb,
					account: 'HDB',
				},
			],
		};
		this.accounts = {
			SYS: {
				users: sysUsers,
			},
			HDB: {
				users: hdbUsers,
				jetstream: 'enabled',
			},
		};
		this.system_account = 'SYS';
	}
}

module.exports = LeafConfigObject;
