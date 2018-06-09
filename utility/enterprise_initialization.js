const search = require('../data_layer/search'),
      winston = require('../utility/logging/winston_logger');
const PropertiesReader = require('properties-reader');
let hdb_properties = PropertiesReader(`${process.cwd()}/../hdb_boot_properties.file`);
const ClusterServer = require('../server/clustering/cluster_server');

hdb_properties.append(hdb_properties.get('settings_path'));

function kickOffEnterprise(callback){
    if (hdb_properties.get('CLUSTERING')) {
        var node = {
            "name": hdb_properties.get('NODE_NAME'),
            "port": hdb_properties.get('CLUSTERING_PORT'),

        }



        let search_obj = {
            "table": "hdb_nodes",
            "schema": "system",
            "search_attribute": "host",
            "hash_attribute": "name",
            "search_value": "*",
            "get_attributes": ["*"]
        }
        search.searchByValue(search_obj, function (err, nodes) {
            if (err) {
                winston.error(err);
            }

            if (nodes) {
                node.other_nodes = nodes;
                global.cluster_server = new ClusterServer(node);

                global.cluster_server.init(function (err) {
                    if (err) {
                        return winston.error(err);
                    }
                    global.cluster_server.establishConnections(function (err) {
                        if (err) {
                            return winston.error(err);
                        }


                        winston.info('clustering established');
                        return callback({"clustering":true});

                    })

                });

            }

        });


    }

}

module.exports = {
    kickOffEnterprise:
kickOffEnterprise}