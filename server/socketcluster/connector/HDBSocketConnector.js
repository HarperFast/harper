const SocketConnector = require('./SocketConnector');

class HDBSocketConnector extends SocketConnector{
    constructor(socket_client, name, options, credentials){
        super(socket_client, name, options, credentials);
        this.addEventListener('connect', this.connectHandler.bind(this));
    }

    connectHandler(status){
        this.subscribe('hdb_worker').watch(this.hdbWorkerWatcher.bind(this));
    }

    hdbWorkerWatcher(data){
        if(data.worker_id === this.socket.id){
            //send on
        }
    }
}

module.exports = HDBSocketConnector;