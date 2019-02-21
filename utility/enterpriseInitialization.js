"use strict";

const search = require('../data_layer/search');
const harper_logger = require('../utility/logging/harper_logger');
const env = require('../utility/environment/environmentManager');
const ClusterServer = require('../server/clustering/ClusterServer');

function kickOffEnterprise(callback) {
    let clustering_setting = env.get('CLUSTERING');
    if (clustering_setting && clustering_setting.toString().toLowerCase() === 'true') {
        let node = {
            "name": env.get('NODE_NAME'),
            "port": env.get('CLUSTERING_PORT'),
        };

        let search_obj = {
            "table": "hdb_nodes",
            "schema": "system",
            "search_attribute": "host",
            "hash_attribute": "name",
            "search_value": "*",
            "get_attributes": ["*"]
        };
        search.searchByValue(search_obj, function (err, nodes) {
            if (err) {
                harper_logger.error(err);
            }

            if(!Array.isArray(nodes)){
                nodes = [];
            }

            node.other_nodes = nodes;
            global.cluster_server = new ClusterServer(node, nodes);

            global.cluster_server.init(function (err) {
                if (err) {
                    harper_logger.error(err);
                    return callback(null, {"clustering":false});
                }
                return callback(null, { "clustering":true});
            });

        });
    } else {
        // default to clustering not set response
        return callback(null, {"clustering": false});
    }
}

module.exports = {
    kickOffEnterprise: kickOffEnterprise
};