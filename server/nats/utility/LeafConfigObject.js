'use strict';

const nats_terms = require('./natsTerms');

/**
 * This class represents the config consumed by the Nats leaf server.
 */
class LeafConfigObject {
	constructor(port, node_name, pid_file, js_store_dir, ln_remotes_urls_sys, ln_remotes_urls_hdb, sys_users, hdb_users) {
		this.port = port;
		this.server_name = node_name + nats_terms.SERVER_SUFFIX.LEAF;
		this.pid_file = pid_file;
		this.jetstream = {
			enabled: true,
			store_dir: js_store_dir,
			domain: node_name + nats_terms.SERVER_SUFFIX.LEAF,
		};
		this.leafnodes = {
			remotes: [
				{
					urls: ln_remotes_urls_sys,
					account: 'SYS',
				},
				{
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
