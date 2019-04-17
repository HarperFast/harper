const SocketConnector = require('./SocketConnector');

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
        console.log(process.pid);
        console.log(data);
    }
}

module.exports = HDBSocketConnector;