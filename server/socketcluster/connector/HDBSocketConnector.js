const SocketConnector = require('./SocketConnector');
const get_operation_function = require('../../serverUtilities').getOperationFunction;

class HDBSocketConnector extends SocketConnector{
    constructor(socket_client, name, options, credentials){
        options.query = {hdb_worker:1};
        super(socket_client, name, options, credentials);
        this.addEventListener('connect', this.connectHandler.bind(this));
    }

    connectHandler(status){
        this.subscribe(this.socket.id, this.hdbWorkerWatcher.bind(this));
    }

    hdbWorkerWatcher(data){
        try {
            console.log(process.pid);
            console.log(data);

            let {operation_function} = get_operation_function(data);
            operation_function(data, (err, result) => {
                //TODO possibly would be good to have a queue on the SC side holding pending transactions, on error we send back stating a fail.
                if (err) {
                    console.error(err);
                } else {
                    console.log(result);
                }
            });
        } catch(e){
            console.error(e);
        }

    }

}

module.exports = HDBSocketConnector;