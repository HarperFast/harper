const SocketConnector = require('./SocketConnector');
const get_operation_function = require('../../serverUtilities').getOperationFunction;
const log = require('../../../utility/logging/harper_logger');

class HDBSocketConnector extends SocketConnector{
    constructor(socket_client, name, options, credentials){
        options.query = {hdb_worker:1};
        super(socket_client, name, options, credentials);
        this.addEventListener('connect', this.connectHandler.bind(this));
        this.addEventListener('disconnect', this.disconnectHandler.bind(this));
    }

    connectHandler(status){
        this.subscribe(this.socket.id, this.hdbWorkerWatcher.bind(this));
    }

    disconnectHandler(status){
        log.debug(`worker_${process.pid} disconnected with status: ${status}`);
    }

    hdbWorkerWatcher(data){
        try {
            let {operation_function} = get_operation_function(data);
            operation_function(data, (err, result) => {
                //TODO possibly would be good to have a queue on the SC side holding pending transactions, on error we send back stating a fail.
                if (err) {
                    log.error(err);
                } else {
                    log.debug(result);
                }
            });
        } catch(e){
            log.error(e);
        }

    }

}

module.exports = HDBSocketConnector;