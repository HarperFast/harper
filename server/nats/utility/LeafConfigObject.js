'use strict';

const nats_terms = require('./natsTerms');

/**
 * This class represents the config consumed by the Nats leaf server.
 */
class LeafConfigObject {
	constructor(
		port,
		node_name,
		pid_file,
		js_store_dir,
		ln_remotes_urls_sys,
		ln_remotes_urls_hdb,
		sys_users,
		hdb_users,
		cert_file,
		key_file,
		ca_file,
		insecure
	) {
		this.port = port;
		this.server_name = node_name + nats_terms.SERVER_SUFFIX.LEAF;
		this.pid_file = pid_file;
		this.max_payload = 10000000;
		this.jetstream = {
			enabled: true,
			store_dir: js_store_dir,
			domain: node_name + nats_terms.SERVER_SUFFIX.LEAF,
		};
		this.tls = {
			cert_file,
			key_file,
			ca_file,
			insecure,
		};
		this.leafnodes = {
			remotes: [
				{
					tls: {
						ca_file,
						insecure,
					},
					urls: ln_remotes_urls_sys,
					account: 'SYS',
				},
				{
					tls: {
						ca_file,
						insecure,
					},
					urls: ln_remotes_urls_hdb,
					account: 'HDB',
				},
			],
		};
		this.accounts = {
			SYS: {
				users: sys_users,
			},
			HDB: {
				users: hdb_users,
				jetstream: 'enabled',
			},
		};
		this.system_account = 'SYS';
	}
}

module.exports = LeafConfigObject;
