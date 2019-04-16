const SocketConnector = require('./SocketConnector');

class HDBSocketConnector extends SocketConnector{
    constructor(socket_client, name, options, credentials){
        options.query = {hdb_worker:true};
        super(socket_client, name, options, credentials);
        this.subscribe(this.socket.id, this.hdbWorkerWatcher.bind(this));
    }

    hdbWorkerWatcher(data){
        console.log(data);
    }
}

module.exports = HDBSocketConnector;