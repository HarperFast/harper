"use strict";

const search = require('../data_layer/search');
const log = require('../utility/logging/harper_logger');
const env = require('../utility/environment/environmentManager');
let fork = require('child_process').fork;
const path = require('path');
const promisify = require('util').promisify;
const p_search_by_value = promisify(search.searchByValue);

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
        let sc_data_payload = {
            nodes: nodes,
            schema: schema,
            users: users
        };

        try {
            let child = fork(path.join(__dirname, '../server/socketcluster/Server.js'));
            child.send(sc_data_payload);
        } catch(err) {
            log.error(err);
            return {"clustering": false};
        }
        return {"clustering": true};
    }
    return {"clustering": false};
}


module.exports = {
    kickOffEnterprise: kickOffEnterprise
};