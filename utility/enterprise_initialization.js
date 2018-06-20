"use strict";

const search = require('../data_layer/search');
const harper_logger = require('../utility/logging/harper_logger');
const PropertiesReader = require('properties-reader');
let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
const ClusterServer = require('../server/clustering/cluster_server');

hdb_properties.append(hdb_properties.get('settings_path'));

function kickOffEnterprise(callback){
    if (hdb_properties.get('CLUSTERING')) {
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

            if (nodes) {
                node.other_nodes = nodes;
                global.cluster_server = new ClusterServer(node, nodes);

                global.cluster_server.init(function (err) {
                    if (err) {
                        return harper_logger.error(err);
                    }
                    return callback({"clustering":true});
                });

            }
        });
    }
}

module.exports = {
    kickOffEnterprise: kickOffEnterprise
};