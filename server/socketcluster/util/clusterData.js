'use strict';

const search = require('../../../data_layer/search');
const log = require('../../../utility/logging/harper_logger');
const env = require('../../../utility/environment/environmentManager');
env.initSync();
const promisify = require('util').promisify;
const p_search_by_value = promisify(search.searchByValue);
const hdb_util = require('../../../utility/common_utils');
const schema_funcs = require('../../../data_layer/schemaDescribe');
const user_funcs = require('../../../security/user');

module.exports = async () => {
	log.trace('in kickOffEnterprise');
	let clustering_setting = env.get('CLUSTERING');

	if (clustering_setting && clustering_setting.toString().toLowerCase() === 'true') {
		let search_obj = {
			table: 'hdb_nodes',
			schema: 'system',
			search_attribute: 'name',
			search_value: '*',
			get_attributes: ['*'],
		};

		let nodes = await p_search_by_value(search_obj);
		let schema = await schema_funcs.describeAll();
		let users = await user_funcs.listUsers();

		//get the CLUSTER_USER
		let cluster_user_name = env.get('CLUSTERING_USER');

		if (hdb_util.isEmpty(cluster_user_name)) {
			log.warn('No CLUSTERING_USER specified, cannot start clustering.');
			return;
		}

		let user = hdb_util.getClusterUser(users, cluster_user_name);

		if (hdb_util.isEmpty(user)) {
			log.warn('No CLUSTERING_USER found, cannot start clustering.');
			return;
		}

		let cluster_user = {
			username: user.username,
			hash: user.hash,
		};

		return {
			nodes: nodes,
			schema: schema,
			users: [...users.values()],
			cluster_user: cluster_user,
		};
	}
};
