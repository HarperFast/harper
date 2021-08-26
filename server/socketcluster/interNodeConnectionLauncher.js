'use strict';

const NodeConnector = require('./handlers/NodeConnectionsHandler');
const cluster_data = require('./util/clusterData');
const logger = require('../../utility/logging/harper_logger');

(async()=> {
    logger.info("launching clustering connector");
    let hdb_data = await cluster_data();
    if(hdb_data) {
        let node_connector = new NodeConnector(hdb_data.nodes, hdb_data.cluster_user, this);
        await node_connector.initialize();
    }
})();