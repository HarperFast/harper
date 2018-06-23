"use strict";

const search = require('../data_layer/search');
const harper_logger = require('../utility/logging/harper_logger');
const PropertiesReader = require('properties-reader');
let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
const ClusterServer = require('../server/clustering/ClusterServer');

hdb_properties.append(hdb_properties.get('settings_path'));

function kickOffEnterprise(callback){
    let is_clustering = hdb_properties.get('CLUSTERING');
    // check with all possible values of TRUE, FALSE, true, false, 1, 0, null, undefined
    if (is_clustering && Boolean(typeof is_clustering === 'string'? is_clustering.toLowerCase() === 'true': is_clustering)) {
        let node = {
            "name": hdb_properties.get('NODE_NAME'),
            "port": hdb_properties.get('CLUSTERING_PORT')
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
                return callback({"clustering":false});
            }

            if (nodes && nodes.length) {
                node.other_nodes = nodes;
                global.cluster_server = new ClusterServer(node, nodes);

                global.cluster_server.init(function (err) {
                    if (err) {
                        harper_logger.error(err);
                        return callback({"clustering":false});
                    }
                    global.cluster_server.establishConnections(function (err) {
                        if (err) {
                            harper_logger.error(err);
                            return callback({"clustering":false});
                        }

                        harper_logger.info('clustering established');
                        return callback({"clustering":true});
                    });
                });
            } else {
                return callback({"clustering":false});
            }
        });
    } else {
        return callback({"clustering":false});
    }
}

module.exports = {
    kickOffEnterprise: kickOffEnterprise
};