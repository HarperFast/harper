"use strict";

const search = require('../data_layer/search');
const harper_logger = require('../utility/logging/harper_logger');
const PropertiesReader = require('properties-reader');
const hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
const ClusterServer = require('../server/clustering/ClusterServer');

hdb_properties.append(hdb_properties.get('settings_path'));

function kickOffEnterprise(callback) {
    let clustering_setting = hdb_properties.get('CLUSTERING');
    if (clustering_setting && clustering_setting.toLowerCase() === 'true') {
        let node = {
            "name": hdb_properties.get('NODE_NAME'),
            "port": hdb_properties.get('CLUSTERING_PORT'),
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
            //if (nodes && nodes.length > 0) {
                node.other_nodes = nodes;
                global.cluster_server = new ClusterServer(node, nodes);

                global.cluster_server.init(function (err) {
                    if (err) {
                        harper_logger.error(err);
                        return callback({"clustering":false});
                    }
                    return callback({"clustering":true});
                });

            /*} else {
                return callback({"clustering":false});
            }*/
        });
    } else {
        // default to clustering not set response
        return callback({"clustering": false});
    }
}

module.exports = {
    kickOffEnterprise: kickOffEnterprise
};