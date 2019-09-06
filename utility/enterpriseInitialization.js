"use strict";

const search = require('../data_layer/search');
const log = require('../utility/logging/harper_logger');
const env = require('../utility/environment/environmentManager');
let fork = require('child_process').fork;
const path = require('path');
const promisify = require('util').promisify;
const p_search_by_value = promisify(search.searchByValue);
const fs = require('fs-extra');
const hdb_util = require('./common_utils');
const terms = require('./hdbTerms');

async function kickOffEnterprise() {
    log.trace('in kickOffEnterprise');
    let clustering_setting = env.get('CLUSTERING');
    if (clustering_setting && clustering_setting.toString().toLowerCase() === 'true') {
        let search_obj = {
            "table": "hdb_nodes",
            "schema": "system",
            "search_attribute": "host",
            "hash_attribute": "name",
            "search_value": "*",
            "get_attributes": ["*"]
        };

        let nodes = await p_search_by_value(search_obj);
        let schema = global.hdb_schema;
        let users = global.hdb_users;

        //get the CLUSTER_USER
        let cluster_user_name = env.get('CLUSTERING_USER');

        if(hdb_util.isEmpty(cluster_user_name)){
            log.warn('No CLUSTERING_USER specified, cannot start clustering.');
            return;
        }

        let user = hdb_util.getClusterUser(users, cluster_user_name);

        if(hdb_util.isEmpty(user)){
            log.warn('No CLUSTERING_USER found, cannot start clustering.');
            return;
        }

        let cluster_user = {
            username: user.username,
            hash: user.hash
        };

        let sc_data_payload = {
            nodes: nodes,
            schema: schema,
            users: users,
            cluster_user: cluster_user
        };

        try {
            let file_path = path.join(env.getHdbBasePath(), terms.CLUSTERING_FOLDER_NAME, terms.CLUSTERING_PAYLOAD_FILE_NAME);
            await fs.writeFile(file_path, JSON.stringify(sc_data_payload), {mode: terms.HDB_FILE_PERMISSIONS});
            fork(path.join(__dirname, '../server/socketcluster/Server.js'));
            log.debug('Started Clustering server.');
        } catch(err) {
            log.error(err);
        }
    }
}


module.exports = {
    kickOffEnterprise
};