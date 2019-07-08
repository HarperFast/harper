const SocketConnector = require('./SocketConnector');
const get_operation_function = require('../../serverUtilities').getOperationFunction;
const log = require('../../../utility/logging/harper_logger');
const terms = require('../../../utility/hdbTerms');
const ClusterStatusEmitter = require('../../../events/ClusterStatusEmitter');
const {inspect} = require('util');

class HDBSocketConnector extends SocketConnector{
    constructor(socket_client, additional_info, options, credentials){
        super(socket_client, additional_info, options, credentials);
        this.addEventListener('connect', this.connectHandler.bind(this));
        this.addEventListener('disconnect', this.disconnectHandler.bind(this));
    }

    connectHandler(status){
        this.subscribe(this.socket.id, this.hdbWorkerWatcher.bind(this));
    }

    disconnectHandler(status){
        log.debug(`worker_${process.pid} disconnected with status: ${status}`);
    }

    // When a response is sent from clustering, it ends up here.
    hdbWorkerWatcher(req) {
        try {
            // Assume the message contains an operation, but in the case of cluster status we need to act a little differently.
            if(req.type) {
                switch(req.type) {
                    case terms.CLUSTERING_MESSAGE_TYPES.CLUSTER_STATUS_RESPONSE: {
                        ClusterStatusEmitter.clusterEmitter.emit(ClusterStatusEmitter.EVENT_NAME, req);
                        break;
                    }
                    case terms.CLUSTERING_MESSAGE_TYPES.HDB_TRANSACTION: {
                        log.trace(`Received transaction message with operation: ${req.operation}`);
                        log.trace(`request: ${inspect(req)}`);
                        let {operation_function} = get_operation_function(req.transaction);
                        operation_function(req.transaction, (err, result) => {
                            //TODO possibly would be good to have a queue on the SC side holding pending transactions, on error we send back stating a fail.
                            if (err) {
                                log.error(err);
                            } else {
                                log.debug(result);
                            }
                        });
                        break;
                    }
                    default: {
                        log.info('Invalid message type in hdbWorkerWatcher.');
                        break;
                    }
                }
            } else {
                let {operation_function} = get_operation_function(req);
                operation_function(req, (err, result) => {
                    //TODO possibly would be good to have a queue on the SC side holding pending transactions, on error we send back stating a fail.
                    if (err) {
                        log.error(err);
                    } else {
                        log.debug(result);
                    }
                });
            }
        } catch(e){
            log.error(e);
        }

    }

}

module.exports = HDBSocketConnector;